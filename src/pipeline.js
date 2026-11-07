/* ================================================================
 *  pipeline.js —— 主流程（与 DOM / zip 无关，可在 Node 中测试）
 *
 *  fs 接口：
 *    list()                → 所有文件路径（不含目录）
 *    readText(path)        → Promise<string>
 *    writeText(path, text)
 *    move(from, to)        （仅在需要把根目录的包挪进子文件夹时使用）
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;
    const {
        parseJsonLenient, parseLang, toLangValue, hasCJK, humanizeIdentifier,
        ExtractContext, translateCommand, fileBaseOf,
    } = NS;

    const DEFAULT_OPTIONS = {
        sourceLang: 'auto',            // auto | zh_CN | en_US | ...
        targetLangs: ['en_US', 'zh_CN'],
        splitNewlines: true,
        processScripts: true,
        injectRuntime: true,
        fillMissing: true,
        placeholderNames: true,
        scriptLangFields: '',          // 空 = 自动识别；off = 关闭；s=en_US, v=vi_VN = 手动
        baseName: 'addon',
    };

    const MARK = '## ==== addon-i18n ====';

    function isJunk(path) {
        const parts = path.split('/');
        const name = parts[parts.length - 1];
        if (name.startsWith('._') || ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(name)) return true;
        return parts.some(p => ['__MACOSX', 'node_modules', '.git', '.vscode', '.idea'].includes(p));
    }

    function packTypeOf(manifest) {
        const types = (manifest.modules || []).map(m => m && m.type).filter(Boolean);
        if (types.includes('resources')) return 'RP';
        if (types.some(t => t === 'data' || t === 'script' || t === 'javascript' || t === 'client_data')) return 'BP';
        if (types.includes('skin_pack')) return 'skin';
        if (types.includes('world_template')) return 'world';
        return 'unknown';
    }

    function detectSourceLang(values) {
        let cjk = 0, kana = 0, hangul = 0, total = 0;
        for (const v of values) {
            total++;
            if (/[぀-ヿ]/.test(v)) kana++;
            else if (/[가-힯]/.test(v)) hangul++;
            else if (hasCJK(v)) cjk++;
        }
        if (!total) return 'en_US';
        if (kana / total > 0.2) return 'ja_JP';
        if (hangul / total > 0.2) return 'ko_KR';
        if (cjk / total > 0.3) return 'zh_CN';
        return 'en_US';
    }

    function csvCell(s) {
        const t = String(s == null ? '' : s);
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }

    async function runPipeline(fs, userOptions = {}, log = () => {}) {
        const opt = { ...DEFAULT_OPTIONS, ...userOptions };
        const allFiles = fs.list().filter(p => !isJunk(p));
        const pending = new Map();                 // 路径 → 新内容
        const jsonCache = new Map();
        const readJson = async (p) => {
            if (jsonCache.has(p)) return jsonCache.get(p);
            let data;
            try { data = parseJsonLenient(await fs.readText(p)); } catch (e) { data = undefined; }
            jsonCache.set(p, data);
            return data;
        };

        // ---------------- 1. 识别包 ----------------
        const packs = [];
        for (const p of allFiles) {
            if (!(p === 'manifest.json' || p.endsWith('/manifest.json'))) continue;
            const data = await readJson(p);
            if (!data || !data.header) continue;
            const rootDir = p === 'manifest.json' ? '' : p.slice(0, -'/manifest.json'.length);
            packs.push({ root: rootDir, type: packTypeOf(data), manifestPath: p, manifest: data });
        }
        if (!packs.length) throw new Error('没有找到任何 manifest.json，这不是有效的附加包');
        packs.sort((a, b) => b.root.length - a.root.length);
        const packOf = (p) => packs.find(pk => pk.root === '' || p.startsWith(pk.root + '/'));
        const relOf = (p, pk) => pk.root === '' ? p : p.slice(pk.root.length + 1);
        for (const pk of packs) log(`[包] ${pk.root || '(根目录)'} → ${pk.type}  ${pk.manifest.header.name || ''}`);

        // ---------------- 2. 读取已有 lang ----------------
        const knownKeys = new Set();
        const existingValues = new Map();
        const packLangs = new Map();   // 包根 → Map(语言 → {path, map, raw})
        for (const pk of packs) {
            const langs = new Map();
            for (const p of allFiles) {
                if (packOf(p) !== pk) continue;
                const m = /^texts\/([A-Za-z]{2,3}_[A-Za-z]{2,4})\.lang$/.exec(relOf(p, pk));
                if (!m) continue;
                const raw = await fs.readText(p);
                const map = parseLang(raw);
                langs.set(m[1], { path: p, map, raw });
                for (const [k, v] of map) {
                    knownKeys.add(k);
                    if (!existingValues.has(k)) existingValues.set(k, new Set());
                    existingValues.get(k).add(v);
                }
            }
            packLangs.set(pk.root, langs);
        }
        log(`已有翻译键：${knownKeys.size} 条`);

        const ctx = new ExtractContext({ knownKeys, existingValues, splitNewlines: opt.splitNewlines });
        const info = { defs: { items: [], blocks: [], entities: [], spawnEggs: [] }, packRoot: '' };

        // ---------------- 3. 预扫描 UI / 脚本 ----------------
        const uiData = [];
        const scriptInfos = new Map();
        for (const p of allFiles) {
            const pk = packOf(p);
            if (!pk) continue;
            const rel = relOf(p, pk);
            if (pk.type === 'RP' && /^ui\/.*\.json$/i.test(rel)) {
                const d = await readJson(p);
                if (d) uiData.push({ path: p, data: d });
            }
            if (opt.processScripts && pk.type === 'BP' && /^scripts\/.*\.(js|mjs)$/i.test(rel)) {
                scriptInfos.set(p, NS.collectScriptInfo(await fs.readText(p)));
            }
        }
        info.uiVarUsage = NS.collectUiVarUsage(uiData);
        const userMethods = new Set();
        let usesServerUi = false;
        for (const si of scriptInfos.values()) {
            si.methods.forEach(m => userMethods.add(m));
            if (si.usesServerUi) usesServerUi = true;
        }
        const collidingMethods = new Set(Object.keys(NS.SCRIPT_SINKS).filter(n => userMethods.has(n)));
        const bpManifest = packs.find(p => p.type === 'BP');
        const langFields = (() => {
            const raw = String(opt.scriptLangFields || '').trim();
            if (!raw || raw.toLowerCase() === 'auto') return { mode: 'auto', map: new Map() };
            if (/^(off|none|关闭|否)$/i.test(raw)) return { mode: 'off', map: new Map() };
            // 全局：s=en_US, v=vi_VN    按文件：dialogue_es.js:v=es_ES
            const map = new Map();
            const fileMaps = new Map();
            for (const part of raw.split(/[,，;；\s]+/)) {
                const m = /^(?:([^:=]+\.(?:js|mjs)):)?([^=:]+)=([a-z]{2,3}_[A-Za-z]{2,4})$/.exec(part.trim());
                if (!m) continue;
                if (m[1]) {
                    if (!fileMaps.has(m[1])) fileMaps.set(m[1], new Map());
                    fileMaps.get(m[1]).set(m[2].trim(), m[3]);
                } else map.set(m[2].trim(), m[3]);
            }
            return { mode: 'manual', map, fileMaps: [...fileMaps] };
        })();
        const runtimeKey = '__ADDON_I18N_' + NS.hash6(JSON.stringify(bpManifest ? bpManifest.manifest.header.uuid : opt.baseName));

        // ---------------- 4. 逐文件处理 ----------------
        let processed = 0;
        const total = allFiles.length;
        for (let i = 0; i < allFiles.length; i++) {
            const p = allFiles[i];
            if (opt.onProgress && i % 20 === 0) opt.onProgress(i / total, p);
            const pk = packOf(p);
            if (!pk) continue;
            const rel = relOf(p, pk);
            const lower = rel.toLowerCase();
            info.packRoot = pk.root;

            // ---- mcfunction ----
            if (pk.type === 'BP' && lower.startsWith('functions/') && lower.endsWith('.mcfunction')) {
                const content = await fs.readText(p);
                const base = `function.${fileBaseOf(p)}.message`;
                let changed = false;
                const out = content.split('\n').map(line => {
                    const m = /^(\s*)(.*?)(\r?)$/.exec(line);
                    if (!m[2] || m[2].startsWith('#')) return line;
                    const r = translateCommand(m[2], ctx, base, p);
                    if (!r.changed) return line;
                    changed = true;
                    return m[1] + r.cmd + m[3];
                }).join('\n');
                if (changed) { pending.set(p, out); processed++; log(`[函数] ${p}`); }
                continue;
            }

            // ---- 脚本 ----
            if (pk.type === 'BP' && /^scripts\/.*\.(js|mjs)$/i.test(rel)) {
                if (!opt.processScripts) continue;
                const content = await fs.readText(p);
                const r = NS.processScript(content, p, ctx, {
                    info: scriptInfos.get(p), formSinksEnabled: usesServerUi, collidingMethods,
                    runtimeKey, injectRuntime: opt.injectRuntime, langFields,
                });
                if (r.changed) {
                    pending.set(p, r.content);
                    processed++;
                    log(`[脚本] ${p}（静态改写 ${r.stats.overrides} 处，运行时登记 ${r.stats.exact + r.stats.patterns} 条${r.stats.tables ? `，合并自带多语言 ${r.stats.tables} 条` : ''}）`);
                }
                continue;
            }

            // ---- 结构文件 ----
            if (pk.type === 'BP' && lower.startsWith('structures/') && lower.endsWith('.mcstructure') && NS.convertStructureBytes && fs.readBytes) {
                try {
                    const r = NS.convertStructureBytes(await fs.readBytes(p), p, ctx);
                    if (r.changed) { fs.writeBytes(p, r.bytes); processed++; log(`[结构] ${p}`); }
                } catch (e) { log(`[跳过] ${p}：${e.message}`, 'warn'); }
                continue;
            }

            if (!lower.endsWith('.json')) continue;
            const data = await readJson(p);
            if (data === undefined) { log(`[跳过] ${p}：JSON 解析失败`, 'warn'); continue; }
            if (!data || typeof data !== 'object') continue;

            let changed = false;
            if (rel === 'manifest.json') {
                changed = NS.processManifest(data, p, ctx, info);
            } else if (pk.type === 'BP') {
                if (lower.startsWith('items/')) changed = NS.processItem(data, p, ctx, info);
                else if (lower.startsWith('blocks/')) changed = NS.processBlock(data, p, ctx, info);
                else if (lower.startsWith('entities/')) changed = NS.processEntity(data, p, ctx, info);
                else if (lower.startsWith('dialogue/')) changed = NS.processDialogue(data, p, ctx, info);
                else if (lower.startsWith('animation_controllers/')) changed = NS.processAnimationCommands(data, p, ctx, 'animctrl');
                else if (lower.startsWith('animations/')) changed = NS.processAnimationCommands(data, p, ctx, 'animation');
                else if (lower.startsWith('loot_tables/') || lower.startsWith('trading/')) NS.reportLootNames(data, p, ctx);
            } else if (pk.type === 'RP') {
                if (lower.startsWith('ui/')) changed = NS.processUI(data, p, ctx, info);
                else if (lower === 'splashes.json') NS.reportSplashes(data, p, ctx);
                else if (lower.startsWith('entity/') && data['minecraft:client_entity']) {
                    const d = data['minecraft:client_entity'].description || {};
                    if (d.identifier && d.spawn_egg) info.defs.spawnEggs.push(d.identifier);
                }
            }
            if (changed) {
                pending.set(p, JSON.stringify(data, null, 2));
                processed++;
                if (rel !== 'manifest.json') log(`[JSON] ${p}`);
            }
        }

        // 被翻译文本所在标签原来是 "localize": false 的，已改成 true —— 这些文件可能不是当前处理的文件
        if (info.uiDirty && info.uiDirty.size) {
            for (const p of info.uiDirty) {
                if (!pending.has(p)) processed++;
                pending.set(p, JSON.stringify(jsonCache.get(p), null, 2));
            }
            log(`[UI] ${info.localizeFlips} 个标签原为 "localize": false，已改为 true，否则会直接显示键名`, 'warn');
        }

        // ---------------- 5. 缺失的默认名称 ----------------
        const placeholders = [];
        if (opt.placeholderNames) {
            const addPh = (key, id, kind) => {
                if (knownKeys.has(key) || ctx.entries.has(key)) return;
                ctx.entries.set(key, { value: humanizeIdentifier(id), file: '', kind: 'placeholder' });
                ctx.used.add(key);
                placeholders.push(key);
            };
            for (const b of info.defs.blocks) if (!b.hasName) addPh(`tile.${b.id}.name`, b.id, 'block');
            for (const e of info.defs.entities) addPh(`entity.${e.id}.name`, e.id, 'entity');
            for (const id of info.defs.spawnEggs) addPh(`item.spawn_egg.entity.${id}.name`, id, 'spawn_egg');
            for (const it of info.defs.items) {
                if (it.hasName || !it.isDataDriven) continue;
                const cands = [`item.${it.id}.name`, `item.${it.id}`, `tile.${it.id}.name`];
                if (cands.some(k => knownKeys.has(k))) continue;
                const key = `item.${it.id}.name`;
                it.data['minecraft:item'].components['minecraft:display_name'] = { value: key };
                pending.set(it.file, JSON.stringify(it.data, null, 2));
                addPh(key, it.id, 'item');
            }
            if (placeholders.length) log(`为 ${placeholders.length} 个没有名称的物品/方块/实体生成了占位名称（按 ID 推测，建议人工确认）`, 'warn');
        }

        // 引用了但哪都没定义的键
        const missingRefs = [...ctx.referenced.entries()].filter(([k]) =>
            !knownKeys.has(k) && !ctx.entries.has(k) && !/^(gui|options|menu|item|tile|entity|action|container|commands|death|effect|enchantment|potion|block|key|chat|selectWorld|createWorld|accessibility|tooltip|record|structure_block|hbui|xbox)\./.test(k));

        // ---------------- 6. 确定源语言 ----------------
        const values = [...ctx.entries.values()].map(e => e.value);
        for (const m of ctx.packEntries.values()) values.push(...m.values());
        const sourceLang = opt.sourceLang === 'auto' ? detectSourceLang(values) : opt.sourceLang;
        log(`源语言：${sourceLang}${opt.sourceLang === 'auto' ? '（自动识别）' : ''}`);

        // ---------------- 7. 没有资源包时新建一个 ----------------
        let rps = packs.filter(p => p.type === 'RP');
        let createdRP = null;
        let restructured = false;
        if (!rps.length && ctx.entries.size > 0) {
            const bps = packs.filter(p => p.type === 'BP');
            // 包在压缩包根目录（单个 .mcpack）→ 挪进子文件夹，才能和新资源包一起打成 .mcaddon
            const rootPack = packs.find(p => p.root === '');
            if (rootPack) {
                const newRoot = `${NS.sanitizeKeyPart(opt.baseName)}_BP`;
                for (const f of fs.list()) fs.move(f, `${newRoot}/${f}`);
                for (const [k, v] of [...pending]) { pending.delete(k); pending.set(`${newRoot}/${k}`, v); }
                if (ctx.packEntries.has('')) { ctx.packEntries.set(newRoot, ctx.packEntries.get('')); ctx.packEntries.delete(''); }
                if (packLangs.has('')) {
                    const l = packLangs.get('');
                    for (const v of l.values()) v.path = `${newRoot}/${v.path}`;
                    packLangs.set(newRoot, l);
                    packLangs.delete('');
                }
                rootPack.root = newRoot;
                rootPack.manifestPath = `${newRoot}/manifest.json`;
                restructured = true;
                log(`[结构] 行为包移入 ${newRoot}/ 以便附带新的资源包`, 'warn');
            }
            const bpName = (bps[0] && bps[0].manifest.header.name) || opt.baseName;
            const realBpName = ctx.packEntries.get(bps[0] && bps[0].root)?.get('pack.name') || bpName;
            const rpRoot = `${NS.sanitizeKeyPart(opt.baseName)}_texts_RP`;
            const uuid = () => (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
                : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                });
            const minEngine = (bps[0] && bps[0].manifest.header.min_engine_version) || [1, 20, 0];
            const manifest = {
                format_version: 2,
                header: { name: 'pack.name', description: 'pack.description', uuid: uuid(), version: [1, 0, 0], min_engine_version: minEngine },
                modules: [{ type: 'resources', uuid: uuid(), version: [1, 0, 0] }],
            };
            pending.set(`${rpRoot}/manifest.json`, JSON.stringify(manifest, null, 2));
            createdRP = { root: rpRoot, type: 'RP', manifestPath: `${rpRoot}/manifest.json`, manifest };
            packs.push(createdRP);
            packLangs.set(rpRoot, new Map());
            ctx.setPackEntry(rpRoot, 'pack.name', `${realBpName} - Texts`);
            ctx.setPackEntry(rpRoot, 'pack.description', `Translations for ${realBpName}`);
            // 行为包依赖新资源包，保证一起启用
            for (const bp of bps) {
                const m = bp.manifest;
                m.dependencies = Array.isArray(m.dependencies) ? m.dependencies : [];
                m.dependencies.push({ uuid: manifest.header.uuid, version: [1, 0, 0] });
                pending.set(bp.manifestPath, JSON.stringify(m, null, 2));
            }
            rps = [createdRP];
            log(`[新建] 附加包没有资源包，翻译只能放在资源包里 → 已新建 ${rpRoot}/ 并让行为包依赖它`, 'warn');
        }

        // ---------------- 8. 写 lang ----------------
        const writeLangs = (pk, entries, isRP) => {
            const langs = packLangs.get(pk.root) || new Map();
            const texts = pk.root ? `${pk.root}/texts` : 'texts';
            const langSet = new Set([...langs.keys(), ...opt.targetLangs, sourceLang, 'en_US', ...(isRP ? tableLangs : [])]);
            // 补全用：本包已有的所有键
            const fillFrom = (key) => {
                for (const l of [sourceLang, 'en_US', ...langs.keys()]) {
                    const e = langs.get(l);
                    if (e && e.map.has(key)) return e.map.get(key);
                }
                return null;
            };
            const allExistingKeys = new Set();
            for (const e of langs.values()) for (const k of e.map.keys()) allExistingKeys.add(k);
            const written = [];
            for (const lang of langSet) {
                const e = langs.get(lang);
                const map = e ? e.map : new Map();
                const added = [];
                for (const [k, v] of entries) {
                    if (map.has(k)) continue;
                    // 脚本自带的多语言表里有这种语言的译文 → 直接使用
                    const tr = ctx.translations.get(k);
                    added.push(`${k}=${toLangValue(tr && tr.has(lang) ? tr.get(lang) : v)}`);
                }
                const filled = [];
                if (opt.fillMissing && isRP) {
                    for (const k of allExistingKeys) {
                        if (map.has(k) || entries.has(k)) continue;
                        const v = fillFrom(k);
                        if (v != null) filled.push(`${k}=${v}`);
                    }
                }
                if (!added.length && !filled.length) { if (e) written.push(lang); continue; }
                let out = e ? e.raw.replace(/\s*$/, '\n') : '';
                if (added.length) out += `\n${MARK} 自动提取（源语言 ${sourceLang}${lang === sourceLang ? '' : '，待翻译'}）\n${added.join('\n')}\n`;
                if (filled.length) out += `\n${MARK} 从其他语言补全（待翻译）\n${filled.join('\n')}\n`;
                const path = e ? e.path : `${texts}/${lang}.lang`;
                pending.set(path, out);
                written.push(lang);
                log(`[lang] ${path}：新增 ${added.length}${filled.length ? `，补全 ${filled.length}` : ''}`);
            }
            return written;
        };
        const writeLanguagesJson = async (pk, langs) => {
            const p = pk.root ? `${pk.root}/texts/languages.json` : 'texts/languages.json';
            let list = [];
            if (pending.has(p)) list = JSON.parse(pending.get(p));
            else if (fs.list().includes(p)) {
                const d = parseJsonLenient(await fs.readText(p));
                if (Array.isArray(d)) list = d;
            }
            let changed = false;
            for (const l of langs) if (!list.includes(l)) { list.push(l); changed = true; }
            if (changed) pending.set(p, JSON.stringify(list, null, 2));
        };

        const tableLangs = new Set();
        for (const m of ctx.translations.values()) for (const l of m.keys()) tableLangs.add(l);
        if (tableLangs.size) log(`脚本自带的多语言表包含：${[...tableLangs].join(', ')}，已写入对应语言文件`);
        const newEntries = new Map([...ctx.entries].map(([k, e]) => [k, e.value]));
        for (const pk of packs) {
            const own = ctx.packEntries.get(pk.root) || new Map();
            let entries;
            if (pk.type === 'RP') entries = new Map([...newEntries, ...own]);
            else entries = own;
            if (!entries.size && !(pk.type === 'RP' && opt.fillMissing)) continue;
            // 已存在但值不同的 pack.name：保留原值并提示
            const langs = packLangs.get(pk.root);
            for (const [k, v] of own) {
                const src = langs && (langs.get(sourceLang) || langs.get('en_US'));
                if (src && src.map.has(k) && src.map.get(k) !== v) {
                    ctx.warn(`${pk.manifestPath}: lang 中已有 ${k}=${src.map.get(k)}，与 manifest 原文「${v}」不同，保留 lang 中的值`);
                }
            }
            const written = writeLangs(pk, entries, pk.type === 'RP');
            if (written.length) await writeLanguagesJson(pk, written);
        }

        // ---------------- 9. 写回 ----------------
        for (const [p, c] of pending) fs.writeText(p, c);

        // ---------------- 10. 翻译工作包 ----------------
        const trLangs = [...new Set([...ctx.translations.values()].flatMap(m => [...m.keys()]))];
        const rows = [['key', 'source_text', 'file', 'type', ...trLangs.map(l => `existing_${l}`)]];
        for (const [k, e] of ctx.entries) {
            const tr = ctx.translations.get(k);
            rows.push([k, e.value, e.file, e.kind, ...trLangs.map(l => (tr && tr.get(l)) || '')]);
        }
        for (const [rootDir, m] of ctx.packEntries) for (const [k, v] of m) rows.push([k, v, rootDir + '/manifest.json', 'manifest']);
        const stringsCsv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
        const untrRows = [['file', 'where', 'text', 'reason'], ...ctx.untranslatable.map(u => [u.file, u.where, u.text, u.reason])];
        const untranslatableCsv = '﻿' + untrRows.map(r => r.map(csvCell).join(',')).join('\r\n');
        // 玩家输入匹配表：按内部标记 / 回答汇总，列出已支持的语言，留空列给要补充的语言
        let inputCsv = null;
        if (ctx.inputTables.length) {
            const want = [...new Set([...opt.targetLangs, sourceLang, 'en_US', ...tableLangs])];
            const merged = new Map();
            for (const r of ctx.inputTables) {
                const id = r.kind === '归一化' ? `归一化\u0000${r.target}` : `触发\u0000${r.answer || r.regex}`;
                if (!merged.has(id)) merged.set(id, { ...r, phrases: [], keywords: [], langs: new Set(), regex: [], files: new Set() });
                const m = merged.get(id);
                m.phrases.push(...r.phrases); m.keywords.push(...r.keywords);
                r.langs.forEach(l => m.langs.add(l)); if (r.regex) m.regex.push(r.regex); m.files.add(r.file);
            }
            const head = ['type', 'maps_to', 'answer_key', 'phrases_now', 'keywords_now', 'languages_now', 'missing_languages', 'regex', 'file',
                ...want.map(l => `add_${l}`)];
            const lines = [head];
            for (const m of merged.values()) {
                const answerKey = m.answer ? (ctx.dedupe.get('script\u0000' + m.answer) || '') : '';
                const missing = want.filter(l => !m.langs.has(l));
                lines.push([m.kind, m.target || m.answer.slice(0, 60), answerKey, [...new Set(m.phrases)].join(' | '),
                    [...new Set(m.keywords)].join(' | '), [...m.langs].join(' '), missing.join(' '), m.regex.join(' '),
                    [...m.files].join(' '), ...want.map(() => '')]);
            }
            inputCsv = '\ufeff' + lines.map(r => r.map(csvCell).join(',')).join('\r\n');
            log(`玩家输入匹配（聊天关键词/正则）${merged.size} 组：游戏不会翻译玩家输入，已导出到翻译表 input_aliases.csv，可按语言补充说法`, 'warn');
        }
        const sourceLangFile = [...ctx.entries].map(([k, e]) => `${k}=${toLangValue(e.value)}`).join('\n') + '\n';

        const summary = {
            packs: packs.map(p => ({ root: p.root, type: p.type })),
            processedFiles: processed,
            newKeys: ctx.entries.size,
            packKeys: [...ctx.packEntries.values()].reduce((a, m) => a + m.size, 0),
            placeholders: placeholders.length,
            untranslatable: ctx.untranslatable.length,
            warnings: ctx.warnings,
            missingRefs,
            inputGroups: ctx.inputTables.length,
            sourceLang,
            createdRP: createdRP ? createdRP.root : null,
            restructured,
        };
        return {
            ctx, summary,
            workbook: {
                'strings.csv': stringsCsv,
                'untranslatable.csv': untranslatableCsv,
                ...(inputCsv ? { 'input_aliases.csv': inputCsv } : {}),
                [`source_${sourceLang}.lang`]: sourceLangFile,
            },
        };
    }

    NS.runPipeline = runPipeline;
    NS.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
    NS.detectSourceLang = detectSourceLang;
})(typeof globalThis !== 'undefined' ? globalThis : this);
