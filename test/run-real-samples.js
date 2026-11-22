// 真实样本回归入口。不接入 test/run-tests.js，也不接入公开 Tests 工作流。
//
// 环境变量 LFMC_SAMPLE_ROOT 指向私人样本仓库根目录。未设置时打印跳过并退出 0。
// 设置了但登记、路径、大小、SHA-256、ZIP 或 manifest 版本不合格时退出 1，不调用转换。
// 五项检查各自给出 PASS、FAIL 或 UNCOVERED。有 FAIL 退出 1；没有 FAIL 但有 UNCOVERED 退出 2；
// 五项都是 PASS 才退出 0。整包转换成功不能代替这五项。
//
// 二次转换的测试类型是「只回填译文 lang 到原始文件树」：第二次只把第一次写出的 lang
// 放回原始文件树，不拿完整转换产物再跑一遍。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { NS, MemFS, readDir } = require('./load.js');

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

function readManifestVersion(zipFile, member) {
    const raw = execFileSync('unzip', ['-p', zipFile, member], { maxBuffer: 2 * 1024 * 1024 });
    const data = JSON.parse(String(raw));
    return versionText(data && data.header && data.header.version);
}

function langKeyLines(text) {
    const counts = new Map();
    for (let line of String(text).split('\n')) {
        line = line.replace(/\r$/, '');
        const t = line.trimStart();
        if (!t || t.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
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

function commandLiterals(info, file) {
    const found = [];
    if (!info.ok || !info.ast) return found;
    eachNode(info.ast, (node) => {
        let text = null;
        let where = '';
        if (node.type === 'Literal' && typeof node.value === 'string') {
            text = node.value;
            where = '字符串字面量';
        } else if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
            text = node.quasis[0].value.cooked || '';
            where = '模板字符串';
        }
        if (!text || !text.includes('event entity') || !NS.looksLikeCommand(text)) return;
        found.push({ file, where, text });
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
    let zipOk = true;
    try { execFileSync('unzip', ['-t', '-q', packPath], { stdio: 'pipe' }); }
    catch (e) { zipOk = false; }
    if (!zipOk) throw new Error('原包 ZIP 完整性检查失败，未开始转换');
    const bpVersion = readManifestVersion(packPath, 'bp0/manifest.json');
    const rpVersion = readManifestVersion(packPath, 'rp0/manifest.json');
    if (bpVersion !== entry.version || rpVersion !== entry.version) {
        throw new Error(`manifest 版本 bp=${bpVersion} rp=${rpVersion}，登记版本是 ${entry.version}`);
    }
    return { entry, packPath, digest, bpVersion, rpVersion };
}

function checkDictionary(info, ctx, mem) {
    const groups = info.ok ? NS.collectTranslationGroups(info.ast, { mode: 'auto', map: new Map() }).groups : [];
    if (!groups.length) {
        return {
            id: 'dictionary',
            status: 'UNCOVERED',
            input: { script: 'bp0/scripts/imports.js', groups: 0 },
            output: null,
            basis: 'collectTranslationGroups 没有得到可断言的语言组，不能把转换成功当成这项通过。',
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
    for (const group of groups) {
        const expected = normalizedGroup(group);
        if (!expected) {
            missing.push({ reason: '占位符无法按源语言对齐，转换不会写入这一组', sample: clip(group.values().next().value.value) });
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
            const detail = { langs: expected.map(([lang, value]) => [lang, clip(value)]) };
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
            if (!hit) missing.push({ key, lang, sample: clip(value) });
            else files.push({ lang, path: hit, key });
        }
        if (files.length === expected.length) matched.push({ key, files });
    }
    const status = missing.length ? 'FAIL' : 'PASS';
    return {
        id: 'dictionary',
        status,
        input: {
            script: 'bp0/scripts/imports.js',
            groups: groups.length,
            sample: (status === 'PASS' ? matched[0] : missing[0]) || null,
        },
        output: { matched: matched.length, missingCount: missing.length, missing: missing.slice(0, 5), translationKeys: ctx.translations.size },
        basis: status === 'PASS'
            ? '每个语言组都能在 ctx.translations 找到键，并且对应 texts/<语言>.lang 里的值与字典原文经 toLangValue 后一致。'
            : '有语言组没有进入 ctx.translations，或 lang 文件中的值与字典原文不一致。',
    };
}

function checkEventEntity(info, ctx, scriptPath, converted) {
    const inputs = commandLiterals(info, scriptPath);
    if (!inputs.length) {
        return {
            id: 'event-entity',
            status: 'UNCOVERED',
            input: { script: scriptPath, commands: 0 },
            output: null,
            basis: '脚本里没有被 looksLikeCommand 接受的 event entity 字面量，这项没有可断言的输入。',
        };
    }
    const values = entryValues(ctx);
    const blocked = untranslatableTexts(ctx);
    const leaked = inputs.filter(item => values.has(item.text) || blocked.has(item.text));
    const sourceKept = converted.includes('event entity');
    const status = leaked.length || !sourceKept ? 'FAIL' : 'PASS';
    return {
        id: 'event-entity',
        status,
        input: { script: scriptPath, commands: inputs.length, sample: clip(inputs[0].text) },
        output: { leaked: leaked.slice(0, 3).map(item => clip(item.text)), sourceContainsEventEntity: sourceKept },
        basis: status === 'PASS'
            ? '这些字面量由 looksLikeCommand 判定为命令；它们没有进入 ctx.entries 或 ctx.untranslatable，转换后的脚本仍保留 event entity。'
            : '命令字面量进入了玩家可见条目，或转换后的脚本不再包含 event entity。',
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

function checkPutBack(originalDir, firstMem) {
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
    const secondFiles = readDir(originalDir);
    const prefixed = new Map();
    const deprefixed = new Map();
    const beforeKeys = new Map();
    for (const rel of produced) {
        const changed = prefixTranslatedLang(textOf(firstMem.files.get(rel)));
        if (!changed.keys.length) continue;
        secondFiles.set(rel, changed.text);
        prefixed.set(rel, new Set(changed.keys));
        beforeKeys.set(rel, langKeyLines(changed.text));
        const parsed = NS.parseLang(changed.text);
        const values = new Map();
        for (const key of changed.keys) {
            const value = parsed.get(key);
            if (typeof value === 'string' && value.startsWith('译:')) values.set(key, value.slice(2));
        }
        deprefixed.set(rel, values);
    }
    if (!prefixed.size) {
        return {
            id: 'put-back-lang',
            testType: '只回填译文 lang 到原始文件树',
            status: 'UNCOVERED',
            input: { markedLangFiles: produced.length, prefixedKeys: 0 },
            output: null,
            basis: '带标记的 lang 里没有可改写的键值行。',
        };
    }
    const mem = new MemFS(secondFiles);
    const logs = [];
    return memRun(mem, logs).then((second) => {
        const failures = [];
        const samples = [];
        const tally = { lost: 0, duplicate: 0, prefixDropped: 0, rebuilt: 0 };
        for (const [rel, keys] of prefixed) {
            const output = textOf(mem.files.get(rel));
            const counts = langKeyLines(output);
            const parsed = NS.parseLang(output);
            for (const key of keys) {
                const value = parsed.get(key);
                if ((counts.get(key) || 0) !== 1) {
                    const count = counts.get(key) || 0;
                    if (count === 0) tally.lost++;
                    else tally.duplicate++;
                    if (failures.length < 5) failures.push({ path: rel, key, problem: count === 0 ? '回填的键在第二次输出中消失' : '同一文件出现重复键', count });
                } else if (typeof value !== 'string' || !value.startsWith('译:')) {
                    tally.prefixDropped++;
                    if (failures.length < 5) failures.push({ path: rel, key, problem: '回填值不再以 译: 开头', value: clip(value) });
                }
            }
            const prior = beforeKeys.get(rel);
            const originals = new Set(deprefixed.get(rel).values());
            const rebuilt = [];
            for (const [key, value] of parsed) {
                if (prior.has(key) || typeof value !== 'string') continue;
                if (originals.has(value) || originals.has(value.startsWith('译:') ? value.slice(2) : value)) rebuilt.push(key);
            }
            if (rebuilt.length) {
                tally.rebuilt += rebuilt.length;
                if (failures.length < 5) failures.push({ path: rel, problem: '第二次为同一批句子新增了键', keys: rebuilt.slice(0, 5) });
            }
            samples.push({ path: rel, prefixedKeys: keys.size, outputKeys: counts.size });
        }
        const status = failures.length ? 'FAIL' : 'PASS';
        return {
            id: 'put-back-lang',
            testType: '只回填译文 lang 到原始文件树',
            status,
            input: { files: samples, secondNewKeys: second.summary.newKeys },
            output: { tally, failures },
            basis: status === 'PASS'
                ? '第二次只把带 译: 前缀的 lang 放回未转换的原始文件树。这些键仍各出现一次，值仍以 译: 开头，文件中没有新增另一套键。'
                : '回填后的 lang 丢了前缀、出现重复键，或第二次转换又建了新键。',
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
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lfmc-real-'));
    const report = {
        sample: SAMPLE_ID,
        testType: '只回填译文 lang 到原始文件树',
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
        const extractDir = path.join(work, 'pack');
        fs.mkdirSync(extractDir);
        execFileSync('unzip', ['-q', sample.packPath, '-d', extractDir], { stdio: 'pipe' });
        const files = readDir(extractDir);
        const mem = new MemFS(files);
        const scriptPath = [...files.keys()].find(p => p.endsWith('bp0/scripts/imports.js'));
        if (!scriptPath) throw new Error('解压结果中没有 bp0/scripts/imports.js');
        const info = NS.collectScriptInfo(await mem.readText(scriptPath));
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
            console.error('[real-sample] dictionary', report.checks.at(-1).status, report.checks.at(-1).output.matched + '/' + (report.checks.at(-1).output.matched + report.checks.at(-1).output.missingCount));
            report.checks.push(checkEventEntity(info, result.ctx, scriptPath, converted));
            console.error('[real-sample] event-entity', report.checks.at(-1).status);
            report.checks.push(checkShortVariables(info, result.ctx, scriptPath));
            console.error('[real-sample] short-variable', report.checks.at(-1).status);
            report.checks.push(checkAscii(info, result.ctx, scriptPath));
            console.error('[real-sample] ascii-hud', report.checks.at(-1).status);
            report.checks.push(await checkPutBack(extractDir, mem));
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
        fs.rmSync(work, { recursive: true, force: true });
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
