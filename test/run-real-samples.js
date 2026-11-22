// 真实样本回归入口。不接入 test/run-tests.js，也不接入公开 Tests 工作流。
//
// 环境变量 LFMC_SAMPLE_ROOT 指向私人样本仓库根目录。未设置时打印跳过并退出 0。
// 设置了但登记、路径、大小、SHA-256、ZIP 或 manifest 版本不合格时退出 1，不调用转换。
// 五项检查各自给出 PASS、FAIL 或 UNCOVERED。有 FAIL 退出 1；没有 FAIL 但有 UNCOVERED 退出 2；
// 五项都是 PASS 才退出 0。整包转换成功不能代替这五项。
//
// 二次转换的测试类型是「只回填译文 lang 到原始文件树」：第二次只把第一次写出的 lang
// 放回原始文件树，不拿完整转换产物再跑一遍。
// ZIP 由 vendor/jszip.min.js 在内存中读取。启动时如果这个文件不能加载，直接失败，不调用系统 unzip。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NS, MemFS } = require('./load.js');

// 读取 ZIP 只用仓库自带的 JSZip，不调用系统 unzip。Windows 上没有 unzip.exe 也能跑。
function loadJSZip() {
    let JSZip;
    try { JSZip = require('../vendor/jszip.min.js'); }
    catch (e) { throw new Error('无法加载 vendor/jszip.min.js，真实样本入口不能读取 mcaddon：' + e.message); }
    if (!JSZip || typeof JSZip.loadAsync !== 'function') {
        throw new Error('vendor/jszip.min.js 没有提供 JSZip.loadAsync，已停止，未开始转换。');
    }
    return JSZip;
}

const SAMPLE_ID = 'bedrock-reimagined';
const MARK = '## ==== addon-i18n ====';
const DISPLAY_METHODS = new Set(['sendMessage', 'setActionBar', 'setTitle']);

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(1024 * 1024);
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function insideRoot(root, target) {
    const base = path.resolve(root);
    const abs = path.resolve(target);
    return abs === base || abs.startsWith(base + path.sep);
}

function versionText(version) {
    if (Array.isArray(version)) return version.join('.');
    return String(version == null ? '' : version);
}

function manifestVersion(files, member) {
    const raw = files.get(member);
    if (raw == null) throw new Error('ZIP 中没有 ' + member + '，未开始转换');
    let data;
    try { data = JSON.parse(textOf(raw)); }
    catch (e) { throw new Error(member + ' 不是合法 JSON，未开始转换'); }
    return versionText(data && data.header && data.header.version);
}

async function readZip(packPath) {
    const JSZip = loadJSZip();
    let zip;
    try { zip = await JSZip.loadAsync(fs.readFileSync(packPath)); }
    catch (e) { throw new Error('原包 ZIP 无法用内置 JSZip 打开，未开始转换：' + e.message); }
    const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    const files = new Map();
    for (let i = 0; i < names.length; i += 100) {
        const slice = names.slice(i, i + 100);
        const buffers = await Promise.all(slice.map(name => zip.files[name].async('nodebuffer')));
        slice.forEach((name, index) => {
            const rel = name.replace(/\\/g, '/');
            if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('ZIP 内路径越界：' + name);
            files.set(rel, buffers[index]);
        });
    }
    return files;
}

function langEntries(text) {
    const map = new Map();
    for (let line of String(text).split('\n')) {
        line = line.replace(/\r$/, '');
        const t = line.trimStart();
        if (!t || t.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!key) continue;
        let value = line.slice(eq + 1);
        const cuts = [value.indexOf('##'), value.indexOf('\t#')].filter(index => index >= 0);
        if (cuts.length) value = value.slice(0, Math.min(...cuts));
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
    }
    return map;
}

function prefixTranslatedLang(text) {
    const at = text.indexOf(MARK);
    if (at < 0) return { text, keys: [] };
    const head = text.slice(0, at);
    const tail = text.slice(at);
    const keys = [];
    const next = tail.replace(/^([^#\r\n=][^=\r\n]*)=(.*)$/gm, (line, key, value) => {
        keys.push(key.trim());
        return `${key}=译:${value}`;
    });
    return { text: head + next, keys };
}

function textOf(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return Buffer.from(value).toString('utf8');
}

function normalizedGroup(group) {
    const PH = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{(\d{1,2})\}|%(?:(\d)\$)?s/g;
    const phNames = (text) => {
        let seq = 0;
        return [...String(text).matchAll(PH)].map(m => m[1] || (m[2] != null ? '#' + m[2] : '%' + (m[3] || ++seq)));
    };
    const pickSource = () => {
        for (const lang of ['en_US', 'en_GB']) if (group.has(lang)) return [lang, group.get(lang)];
        const latin = [...group.entries()].find(([, node]) => !/[^\u0000-\u024f\u1e00-\u1eff\s\p{P}\p{S}\p{N}]/u.test(node.value));
        return latin || [...group.entries()][0];
    };
    const source = pickSource();
    const names = phNames(source[1].value);
    if (!names.length) return [...group.entries()].map(([lang, node]) => [lang, node.value]);
    const unique = [...new Set(names)];
    const toParts = (text) => {
        const parts = [];
        let last = 0;
        let seq = 0;
        for (const match of String(text).matchAll(PH)) {
            if (match.index > last) parts.push({ lit: text.slice(last, match.index) });
            const index = unique.indexOf(match[1] || (match[2] != null ? '#' + match[2] : '%' + (match[3] || ++seq))) + 1;
            if (!index) return null;
            parts.push({ g: index });
            last = match.index + match[0].length;
        }
        if (last < text.length) parts.push({ lit: text.slice(last) });
        return parts;
    };
    const percentOnly = names.every(name => name[0] === '%');
    const toValue = (parts) => parts.map(part => part.lit != null ? NS.pctArgs(part.lit) : `%${part.g}$s`).join('');
    const out = [];
    for (const [lang, node] of group) {
        if (percentOnly) { out.push([lang, node.value]); continue; }
        const parts = toParts(node.value);
        if (!parts) return null;
        out.push([lang, toValue(parts)]);
    }
    return out;
}

function clip(text, n = 80) {
    const s = String(text).replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function entryValues(ctx) {
    const values = new Set();
    for (const entry of ctx.entries.values()) values.add(entry.value);
    return values;
}

function untranslatableTexts(ctx) {
    return new Set(ctx.untranslatable.map(item => item.text));
}

function functionOf(node) {
    let cur = node;
    while (cur) {
        if (/Function/.test(cur.type)) return cur;
        cur = cur.parent;
    }
    return null;
}

function calleeName(node) {
    if (!node || node.type !== 'CallExpression') return '';
    const callee = node.callee;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
    return '';
}

function stringInit(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
    return null;
}

function eachNode(ast, visit) {
    const stack = [ast];
    const seen = new Set();
    while (stack.length) {
        const cur = stack.pop();
        if (!cur || seen.has(cur)) continue;
        seen.add(cur);
        visit(cur);
        for (const key of Object.keys(cur)) {
            if (key === 'parent') continue;
            const child = cur[key];
            if (!child || typeof child !== 'object') continue;
            if (Array.isArray(child)) {
                for (const item of child) if (item && typeof item === 'object' && item.type) stack.push(item);
            } else if (child.type) {
                stack.push(child);
            }
        }
    }
}

function flattenCommand(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return { parts: [node.value], dynamic: false };
    if (node.type === 'TemplateLiteral') {
        const parts = [];
        node.quasis.forEach((part, index) => {
            parts.push(part.value.cooked || '');
            if (index < node.expressions.length) parts.push(null);
        });
        return { parts, dynamic: node.expressions.length > 0 };
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        const left = flattenCommand(node.left);
        const right = flattenCommand(node.right);
        if (!left || !right) return { parts: [null], dynamic: true };
        return { parts: left.parts.concat(right.parts), dynamic: true };
    }
    return null;
}

function commandFromArg(node) {
    let current = node;
    while (current && current.type === 'CallExpression' && calleeName(current) === 'C' && current.arguments[0]) current = current.arguments[0];
    const flat = flattenCommand(current);
    if (!flat) return null;
    const text = flat.parts.filter(part => part != null).join('').trim();
    if (!text) return null;
    return { text, dynamic: flat.dynamic || flat.parts.some(part => part == null) };
}

function isEventEntityCommand(text) {
    return NS.looksLikeCommand(text) && /^\/?event\s+entity\b/.test(text);
}

function eventEntityCalls(info, source) {
    const found = [];
    if (!info.ok || !info.ast) return found;
    eachNode(info.ast, (node) => {
        if (node.type !== 'CallExpression') return;
        const name = calleeName(node);
        if (name !== 'runCommand' && name !== 'runCommandAsync') return;
        const command = commandFromArg(node.arguments[0]);
        if (!command || !isEventEntityCommand(command.text)) return;
        found.push({
            callee: name,
            text: command.text,
            dynamic: command.dynamic,
            call: source ? clip(source.slice(node.start, node.end), 140) : '',
        });
    });
    return found;
}

function shortSentenceCandidates(info, file) {
    const found = [];
    if (!info.ok || !info.ast) return found;
    const declCount = new Map();
    eachNode(info.ast, (cur) => {
        if (cur.type === 'VariableDeclarator' && cur.id && cur.id.type === 'Identifier') {
            declCount.set(cur.id.name, (declCount.get(cur.id.name) || 0) + 1);
        }
    });
    const locals = new Map();
    eachNode(info.ast, (node) => {
        if (node.type !== 'VariableDeclarator' || !node.id || node.id.type !== 'Identifier') return;
        const text = stringInit(node.init);
        if (text == null || !NS.looksLikeText(text)) return;
        const name = node.id.name;
        const fn = functionOf(node);
        if (!fn) return;
        if (name.length >= 4 && declCount.get(name) === 1) return;
        if (!locals.has(fn)) locals.set(fn, new Map());
        locals.get(fn).set(name, text);
    });
    const visible = (fn, name) => {
        let cur = fn;
        while (cur) {
            const table = locals.get(cur);
            if (table && table.has(name)) return table.get(name);
            cur = cur.parent;
            while (cur && !/Function/.test(cur.type)) cur = cur.parent;
        }
        return null;
    };
    eachNode(info.ast, (node) => {
        if (!DISPLAY_METHODS.has(calleeName(node))) return;
        const fn = functionOf(node);
        if (!fn) return;
        for (const arg of node.arguments) {
            if (!arg || arg.type !== 'Identifier') continue;
            const text = visible(fn, arg.name);
            if (text == null) continue;
            found.push({
                file,
                name: arg.name,
                text,
                method: calleeName(node),
                reason: arg.name.length < 4 ? '变量名短于 4 个字符' : '同名变量声明不止一次',
            });
        }
    });
    return found;
}

function loadSample(root) {
    const registryPath = path.resolve(root, 'knowledge/samples/registry.json');
    if (!insideRoot(root, registryPath)) throw new Error('登记文件路径越出样本根目录');
    if (!fs.existsSync(registryPath)) throw new Error('登记文件不存在：' + registryPath);
    let registry;
    try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
    catch (e) { throw new Error('登记文件不是合法 JSON：' + e.message); }
    const samples = registry && Array.isArray(registry.samples) ? registry.samples : null;
    if (!samples) throw new Error('登记文件缺少 samples 数组');
    const entry = samples.find(item => item && item.id === SAMPLE_ID);
    if (!entry) throw new Error('登记中没有 id 为 bedrock-reimagined 的样本');
    if (typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path)) {
        throw new Error('登记中的样本路径不合格');
    }
    const packPath = path.resolve(root, entry.path);
    if (!insideRoot(root, packPath)) throw new Error('样本路径越出样本根目录');
    if (!fs.existsSync(packPath)) throw new Error('登记指向的原包不存在：' + packPath);
    const stat = fs.statSync(packPath);
    if (!stat.isFile()) throw new Error('登记指向的原包不是文件');
    if (stat.size !== entry.size) throw new Error(`原包大小 ${stat.size} 与登记 ${entry.size} 不一致`);
    const digest = sha256File(packPath);
    if (digest !== entry.sha256) throw new Error(`原包 SHA-256 ${digest} 与登记不一致`);
    return { entry, packPath, digest };
}

function checkDictionary(info, ctx, mem) {
    const groups = info.ok ? NS.collectTranslationGroups(info.ast, { mode: 'auto', map: new Map() }).groups : [];
    const distinctGroups = [];
    let sameText = 0;
    for (const group of groups) {
        const expected = normalizedGroup(group);
        const rawValues = [...group.values()].map(node => node.value);
        const distinct = new Set((expected || rawValues).map(value => Array.isArray(value) ? value[1] : value));
        if (distinct.size < 2) { sameText++; continue; }
        distinctGroups.push({ group, expected });
    }
    if (!distinctGroups.length) {
        return {
            id: 'dictionary',
            status: 'UNCOVERED',
            input: { script: 'bp0/scripts/imports.js', groups: groups.length, distinctGroups: 0, sameText },
            output: null,
            basis: '没有至少两种不同原文的语言组，这项没有可断言的输入。',
        };
    }
    const langPaths = new Map();
    const parsedLangs = new Map();
    for (const p of mem.list()) {
        const found = p.match(/(?:^|\/)texts\/([a-z]{2}_[A-Z]{2})\.lang$/);
        if (!found) continue;
        if (!langPaths.has(found[1])) langPaths.set(found[1], []);
        langPaths.get(found[1]).push(p);
    }
    const parsed = (p) => {
        if (!parsedLangs.has(p)) parsedLangs.set(p, NS.parseLang(textOf(mem.files.get(p))));
        return parsedLangs.get(p);
    };
    const index = new Map();
    for (const [candidate, langs] of ctx.translations) {
        for (const [lang, value] of langs) {
            const id = lang + '\0' + value;
            if (!index.has(id)) index.set(id, []);
            index.get(id).push(candidate);
        }
    }
    const missing = [];
    const matched = [];
    for (const item of distinctGroups) {
        const expected = item.expected;
        const distinctTexts = [];
        const seen = new Set();
        const raw = item.expected || [...item.group.values()].map(node => ['', node.value]);
        for (const pair of (expected || raw)) {
            const lang = expected ? pair[0] : '';
            const value = expected ? pair[1] : pair[1];
            if (seen.has(value)) continue;
            seen.add(value);
            distinctTexts.push([lang, clip(value)]);
        }
        if (!expected) {
            missing.push({ reason: '占位符无法按源语言对齐，这一组没有写入同一个键', distinctTexts: distinctTexts.slice(0, 2) });
            continue;
        }
        let keys = null;
        for (const [lang, value] of expected) {
            const list = index.get(lang + '\0' + value) || [];
            const set = new Set(list);
            keys = keys ? new Set([...keys].filter(key => set.has(key))) : set;
            if (!keys.size) break;
        }
        const key = keys && [...keys][0];
        if (!key) {
            const detail = { distinctTexts: distinctTexts.slice(0, 2), sharedKey: null };
            if (missing.length < 3) {
                const candidates = new Set();
                for (const [lang, value] of expected) for (const candidate of index.get(lang + '\0' + value) || []) candidates.add(candidate);
                let best = null;
                let score = -1;
                for (const candidate of candidates) {
                    const langs = ctx.translations.get(candidate);
                    const got = expected.filter(([lang, value]) => langs.get(lang) === value).length;
                    if (got > score) { score = got; best = candidate; }
                }
                detail.bestKey = best;
                detail.matchedLangs = score < 0 ? 0 : score;
                detail.langCount = expected.length;
                detail.stored = best ? [...ctx.translations.get(best).entries()].map(([lang, value]) => [lang, clip(value)]) : null;
            }
            missing.push(detail);
            continue;
        }
        const files = [];
        for (const [lang, value] of expected) {
            const want = NS.toLangValue(value);
            const hits = langPaths.get(lang) || [];
            const hit = hits.find(p => parsed(p).get(key) === want);
            if (!hit) missing.push({ sharedKey: key, lang, distinctTexts: distinctTexts.slice(0, 2), sample: clip(value) });
            else files.push({ lang, path: hit, key });
        }
        if (files.length === expected.length) matched.push({ sharedKey: key, distinctTexts: distinctTexts.slice(0, 2), langCount: expected.length });
    }
    const status = missing.length ? 'FAIL' : 'PASS';
    return {
        id: 'dictionary',
        status,
        input: {
            script: 'bp0/scripts/imports.js',
            groups: groups.length,
            distinctGroups: distinctGroups.length,
            sameText,
            sample: (status === 'PASS' ? matched[0] : missing[0]) || null,
        },
        output: { matched: matched.length, missingCount: missing.length, missing: missing.slice(0, 5), translationKeys: ctx.translations.size },
        basis: status === 'PASS'
            ? '每一组都至少有两种不同原文，并且这些语言在 ctx.translations 和各自的 texts/<语言>.lang 里共用同一个键。'
            : '有语言组的不同原文没有落到同一个键，或某个语言的 lang 值与该组原文不一致。',
    };
}

function checkEventEntity(info, ctx, scriptPath, source, converted) {
    const inputs = eventEntityCalls(info, source);
    if (!inputs.length) {
        return {
            id: 'event-entity',
            status: 'UNCOVERED',
            input: { script: scriptPath, calls: 0 },
            output: null,
            basis: '没有找到 runCommand 或 runCommandAsync 调用，且其参数被 looksLikeCommand 接受为 event entity 命令。',
        };
    }
    const convertedInfo = NS.collectScriptInfo(converted);
    const outputs = eventEntityCalls(convertedInfo, converted);
    const outputCounts = new Map();
    for (const call of outputs) outputCounts.set(call.text, (outputCounts.get(call.text) || 0) + 1);
    const inputCounts = new Map();
    for (const call of inputs) inputCounts.set(call.text, (inputCounts.get(call.text) || 0) + 1);
    const values = entryValues(ctx);
    const blocked = untranslatableTexts(ctx);
    const leaked = [];
    const dropped = [];
    for (const [text, count] of inputCounts) {
        if (values.has(text) || blocked.has(text)) leaked.push(clip(text));
        if ((outputCounts.get(text) || 0) < count) dropped.push({ text: clip(text), before: count, after: outputCounts.get(text) || 0 });
    }
    const status = leaked.length || dropped.length ? 'FAIL' : 'PASS';
    return {
        id: 'event-entity',
        status,
        input: { script: scriptPath, calls: inputs.length, sample: inputs[0] },
        output: { convertedCalls: outputs.length, leaked: leaked.slice(0, 3), dropped: dropped.slice(0, 3) },
        basis: status === 'PASS'
            ? '这些是 runCommand / runCommandAsync 的参数，并且 looksLikeCommand 判定为 event entity。它们没有进入 ctx.entries 或 ctx.untranslatable，转换后的同名调用仍带有同样的命令文本。'
            : 'event entity 命令进入了玩家可见条目，或转换后的 runCommand 调用不再带有原来的命令文本。',
    };
}

function checkShortVariables(info, ctx, scriptPath) {
    const inputs = shortSentenceCandidates(info, scriptPath);
    if (!inputs.length) {
        return {
            id: 'short-variable',
            status: 'UNCOVERED',
            input: { script: scriptPath, candidates: 0 },
            output: null,
            basis: '没有找到「短名或重复声明、初值是玩家可见句子、并传给 sendMessage / setActionBar / setTitle」的变量。',
        };
    }
    const values = entryValues(ctx);
    const missed = inputs.filter(item => !values.has(item.text));
    const status = missed.length ? 'FAIL' : 'PASS';
    return {
        id: 'short-variable',
        status,
        input: { script: scriptPath, candidates: inputs.length, sample: { name: inputs[0].name, method: inputs[0].method, text: clip(inputs[0].text), reason: inputs[0].reason } },
        output: { extracted: inputs.length - missed.length, missed: missed.slice(0, 5).map(item => ({ name: item.name, text: clip(item.text) })) },
        basis: status === 'PASS'
            ? '这些句子来自语法树里的短变量或重复声明变量，并且作为显示调用的参数；ctx.entries 仍包含同样的原文。'
            : '短变量规则漏掉了仍应提取的玩家可见句子。',
    };
}

function checkAscii(info, ctx, scriptPath) {
    const infos = new Map([[scriptPath, info]]);
    const texts = NS.collectAsciiPacketTexts(infos);
    if (!texts.size) {
        return {
            id: 'ascii-hud',
            status: 'UNCOVERED',
            input: { script: scriptPath, packets: 0 },
            output: null,
            basis: 'collectAsciiPacketTexts 没有识别到 ASCII 包文字。日志里出现 HUD 字样不能当作这项通过。',
        };
    }
    const values = entryValues(ctx);
    const blocked = untranslatableTexts(ctx);
    const leaked = [...texts.keys()].filter(text => values.has(text) || blocked.has(text));
    const status = leaked.length ? 'FAIL' : 'PASS';
    return {
        id: 'ascii-hud',
        status,
        input: { script: scriptPath, packets: texts.size, sample: clip([...texts.keys()][0]) },
        output: { leaked: leaked.slice(0, 3).map(clip) },
        basis: status === 'PASS'
            ? 'collectAsciiPacketTexts 返回的字符串没有进入 ctx.entries，也没有进入 ctx.untranslatable。'
            : 'ASCII 包文字被当成了可翻译条目或无法翻译的玩家文字。',
    };
}

function checkPutBack(originalFiles, firstMem, firstCtx) {
    const produced = firstMem.list().filter(p => /(?:^|\/)texts\/[a-z]{2}_[A-Z]{2}\.lang$/.test(p) && textOf(firstMem.files.get(p)).includes(MARK));
    if (!produced.length) {
        return {
            id: 'put-back-lang',
            testType: '只回填译文 lang 到原始文件树',
            status: 'UNCOVERED',
            input: { markedLangFiles: 0 },
            output: null,
            basis: '第一次转换没有写出带 addon-i18n 标记的 lang，没有可回填的译文。',
        };
    }
    const secondFiles = new Map(originalFiles);
    const before = new Map();
    const valueKeys = new Map();
    for (const rel of produced) {
        const changed = prefixTranslatedLang(textOf(firstMem.files.get(rel)));
        if (!changed.keys.length) continue;
        secondFiles.set(rel, changed.text);
        const entries = langEntries(changed.text);
        const kept = new Map();
        const unstable = [];
        for (const key of new Set(changed.keys)) {
            const values = entries.get(key) || [];
            if (values.length !== 1) { unstable.push({ path: rel, key, before: values.map(clip) }); continue; }
            kept.set(key, values[0]);
            if (!valueKeys.has(values[0])) valueKeys.set(values[0], new Set());
            valueKeys.get(values[0]).add(key);
        }
        before.set(rel, { kept, unstable });
    }
    if (!before.size) {
        return {
            id: 'put-back-lang',
            testType: '只回填译文 lang 到原始文件树',
            status: 'UNCOVERED',
            input: { markedLangFiles: produced.length, prefixedKeys: 0 },
            output: null,
            basis: '带标记的 lang 里没有可回填的单一键值。',
        };
    }
    const watchedKeys = new Set();
    let unstableCount = 0;
    for (const item of before.values()) {
        unstableCount += item.unstable.length;
        for (const key of item.kept.keys()) watchedKeys.add(key);
    }
    const firstSources = new Map();
    for (const [key, entry] of firstCtx.entries) {
        if (!watchedKeys.has(key)) continue;
        if (!firstSources.has(entry.value)) firstSources.set(entry.value, new Set());
        firstSources.get(entry.value).add(key);
    }
    const mem = new MemFS(secondFiles);
    const logs = [];
    return memRun(mem, logs).then((second) => {
        const tally = { preserved: 0, lost: 0, changed: unstableCount, reassigned: 0 };
        const failures = [];
        for (const item of before.values()) {
            for (const row of item.unstable) if (failures.length < 5) failures.push({ ...row, problem: '回填前这个键就没有唯一值' });
        }
        for (const [rel, item] of before) {
            const kept = item.kept;
            const after = langEntries(textOf(mem.files.get(rel)));
            for (const [key, value] of kept) {
                const got = after.get(key) || [];
                if (got.length === 1 && got[0] === value) { tally.preserved++; continue; }
                if (!got.length) tally.lost++;
                else tally.changed++;
                if (failures.length < 5) failures.push({ path: rel, key, before: clip(value), after: got.map(clip) });
            }
            for (const [key, values] of after) {
                if (kept.has(key)) continue;
                for (const value of values) {
                    const oldKeys = valueKeys.get(value);
                    if (!oldKeys) continue;
                    tally.reassigned++;
                    if (failures.length < 5) failures.push({ path: rel, newKey: key, value: clip(value), oldKeys: [...oldKeys].slice(0, 3) });
                }
            }
        }
        const entryMoves = [];
        for (const [key, entry] of second.ctx.entries) {
            const oldKeys = firstSources.get(entry.value);
            if (!oldKeys || oldKeys.has(key)) continue;
            tally.reassigned++;
            if (entryMoves.length < 5) entryMoves.push({ text: clip(entry.value), oldKeys: [...oldKeys].slice(0, 3), newKey: key });
        }
        const status = tally.lost || tally.changed || tally.reassigned ? 'FAIL' : 'PASS';
        return {
            id: 'put-back-lang',
            testType: '只回填译文 lang 到原始文件树',
            status,
            input: { files: before.size, prefixedKeys: watchedKeys.size, secondNewKeys: second.summary.newKeys },
            output: { tally, failures, entryMoves },
            basis: status === 'PASS'
                ? '第二次只把译文 lang 放回未转换的原始文件树。每个回填键的值与回填时逐字相同，相同原文也没有分到新键。'
                : '回填后的键或值发生了变化，或同一条原文被分到了新键。判断依据是回填前后的键值对，以及两次 ctx.entries 里同一原文对应的键。',
        };
    });
}

function pipelineOptions() {
    return {
        sourceLang: 'auto',
        targetLangs: ['en_US', 'zh_CN'],
        sayMode: 'tellraw',
        processScripts: true,
        injectRuntime: true,
        fillMissing: true,
        placeholderNames: true,
        removeJunkLang: true,
        splitNewlines: false,
        includeHiddenItems: false,
        bakeZh: false,
        scriptLangFields: '',
        baseName: 'ADDON_Bedrock.Reimagined',
    };
}

function memRun(mem, logs) {
    return NS.runPipeline(mem, pipelineOptions(), (msg) => logs.push(String(msg)));
}

async function main() {
    const root = process.env.LFMC_SAMPLE_ROOT;
    if (!root) {
        console.log('LFMC_SAMPLE_ROOT 未设置，跳过真实样本回归。');
        process.exit(0);
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        console.error('LFMC_SAMPLE_ROOT 指向的目录不存在：' + root);
        process.exit(1);
    }
    let sample;
    try { sample = loadSample(root); }
    catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    let files;
    try {
        loadJSZip();
        files = await readZip(sample.packPath);
        const bpVersion = manifestVersion(files, 'bp0/manifest.json');
        const rpVersion = manifestVersion(files, 'rp0/manifest.json');
        if (bpVersion !== sample.entry.version || rpVersion !== sample.entry.version) {
            throw new Error(`manifest 版本 bp=${bpVersion} rp=${rpVersion}，登记版本是 ${sample.entry.version}`);
        }
        sample.bpVersion = bpVersion;
        sample.rpVersion = rpVersion;
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    const report = {
        sample: SAMPLE_ID,
        testType: '只回填译文 lang 到原始文件树',
        zipReader: 'vendor/jszip.min.js',
        pack: {
            path: sample.entry.path,
            size: sample.entry.size,
            sha256Before: sample.digest,
            sha256After: null,
            unchanged: null,
            version: { bp: sample.bpVersion, rp: sample.rpVersion },
        },
        conversion: null,
        checks: [],
    };
    try {
        const mem = new MemFS(files);
        const scriptPath = [...files.keys()].find(p => p.endsWith('bp0/scripts/imports.js'));
        if (!scriptPath) throw new Error('解压结果中没有 bp0/scripts/imports.js');
        const source = textOf(files.get(scriptPath));
        const info = NS.collectScriptInfo(source);
        const logs = [];
        const started = Date.now();
        let result = null;
        try { result = await memRun(mem, logs); }
        catch (e) {
            report.conversion = { ok: false, error: e.message, elapsedMs: Date.now() - started };
            report.checksNote = '正式转换没有完成，五项检查没有执行，不能记为通过。';
        }
        if (result) {
            report.conversion = {
                ok: true,
                elapsedMs: Date.now() - started,
                packs: result.summary.packs,
                processedFiles: result.summary.processedFiles,
                newKeys: result.summary.newKeys,
                warnings: result.summary.warnings,
                logLines: logs.length,
            };
            const converted = textOf(mem.files.get(scriptPath));
            console.error('[real-sample] 正式转换完成，开始五项检查');
            report.checks.push(checkDictionary(info, result.ctx, mem));
            const dictionary = report.checks.at(-1);
            const dictionaryScore = dictionary.output ? dictionary.output.matched + '/' + (dictionary.output.matched + dictionary.output.missingCount) : 'uncovered';
            console.error('[real-sample] dictionary', dictionary.status, dictionaryScore);
            report.checks.push(checkEventEntity(info, result.ctx, scriptPath, source, converted));
            console.error('[real-sample] event-entity', report.checks.at(-1).status);
            report.checks.push(checkShortVariables(info, result.ctx, scriptPath));
            console.error('[real-sample] short-variable', report.checks.at(-1).status);
            report.checks.push(checkAscii(info, result.ctx, scriptPath));
            console.error('[real-sample] ascii-hud', report.checks.at(-1).status);
            report.checks.push(await checkPutBack(files, mem, result.ctx));
            console.error('[real-sample] put-back-lang', report.checks.at(-1).status);
        }
    } catch (e) {
        report.conversion = report.conversion || { ok: false, error: e.message };
        report.checkError = e && e.stack ? e.stack : String(e);
        report.checksNote = report.checksNote || '检查过程中断，未完成的项目不能记为通过。';
    } finally {
        report.pack.sha256After = sha256File(sample.packPath);
        report.pack.unchanged = report.pack.sha256After === report.pack.sha256Before;
        if (report.pack.unchanged === false) {
            report.checks.push({
                id: 'pack-bytes',
                status: 'FAIL',
                input: { sha256Before: report.pack.sha256Before },
                output: { sha256After: report.pack.sha256After },
                basis: '转换后原包字节发生了变化。',
            });
        }
    }
    const expected = ['dictionary', 'event-entity', 'short-variable', 'ascii-hud', 'put-back-lang'];
    const present = new Set(report.checks.map(item => item.id));
    if (expected.some(id => !present.has(id))) {
        report.checksNote = report.checksNote || '五项检查没有全部完成，不能记为通过。';
    }
    const failed = report.checks.some(item => item.status === 'FAIL') || report.pack.unchanged === false || expected.some(id => !present.has(id));
    const uncovered = report.checks.some(item => item.status === 'UNCOVERED');
    report.summary = {
        pass: report.checks.filter(item => item.status === 'PASS').map(item => item.id),
        fail: report.checks.filter(item => item.status === 'FAIL').map(item => item.id),
        uncovered: report.checks.filter(item => item.status === 'UNCOVERED').map(item => item.id),
    };
    console.log(JSON.stringify(report, null, 2));
    if (failed) process.exit(1);
    if (uncovered) process.exit(2);
    process.exit(0);
}

main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
});
