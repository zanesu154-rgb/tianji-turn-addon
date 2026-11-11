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
        parseJsonLenient, parseLang, toLangValue, fixMixedPlaceholders, hasCJK, humanizeIdentifier,
        ExtractContext, translateCommand, fileBaseOf,
    } = NS;

    const DEFAULT_OPTIONS = {
        sourceLang: 'auto',            // auto | zh_CN | en_US | ...
        targetLangs: ['en_US', 'zh_CN'],
        splitNewlines: false,          // lang 支持 \n 换行（游戏内实测），多行文本默认一个键
        sayMode: 'tellraw',            // say/tell 转换：keep | tellraw | titleraw | actionbar
        listCommandBlockNames: false,  // 命令方块名称多为作者工作用标记，默认不列入需人工翻译
        includeHiddenItems: false,
        removeJunkLang: true,
        bakeZh: false,                 // 名字标签等只认纯文字的位置，按简体中文固定写入（仅简体中文界面提供）
        bakeLang: null,                // 上传的已翻译 lang（Map 键→值），优先使用          // 删除语言文件里模板残留的无效条目（见 lang-blacklist.js）     // 创造物品栏里不显示的物品 / 方块、不显示的刷怪蛋：默认不提取
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

        // ---- 包自身的版本号 / 最低可用版本（在日志最后输出，见 app.js） ----
        const packVersions = packs.map(pk => ({ root: pk.root, type: pk.type, name: String(pk.manifest.header.name || ''), version: Array.isArray(pk.manifest.header.version) ? pk.manifest.header.version.join('.') : String(pk.manifest.header.version || '') }));
        // 包名写成翻译键（pack.name）时，等读完 lang 再换成实际名称
        let minVersion = null;
        if (NS.MinVersion) {
            const formats = [];
            for (const p of allFiles) {
                const pk = packOf(p);
                if (!pk || !/^(items|blocks|entities|entity|attachables)\/.+\.json$/i.test(relOf(p, pk))) continue;
                try {
                    const m = /"format_version"\s*:\s*"(\d+\.\d+(?:\.\d+)?)"/.exec(await fs.readText(p));
                    if (m) formats.push({ file: p, version: m[1] });
                } catch (e) { /* 读不了的文件跳过 */ }
            }
            minVersion = NS.MinVersion.estimateAddon({ manifests: packs.map(pk => ({ path: pk.manifestPath, manifest: pk.manifest })), formats });
        }

        // ---------------- 2. 读取已有 lang ----------------
        const knownKeys = new Set();
        const existingValues = new Map();
        const keyLangs = new Map();
        const prevKeys = new Set();
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
                // 上次转换写进去的键（标记行之后）：再次转换时按顺序认领，保留已有译文
                const at = raw.indexOf(MARK);
                if (at >= 0) for (const k of parseLang(raw.slice(at)).keys()) prevKeys.add(k);
                for (const [k, v] of map) {
                    knownKeys.add(k);
                    if (!keyLangs.has(k)) keyLangs.set(k, new Set());
                    keyLangs.get(k).add(m[1]);
                    if (!existingValues.has(k)) existingValues.set(k, new Set());
                    existingValues.get(k).add(v);
                }
            }
            packLangs.set(pk.root, langs);
        }
        log(`已有翻译键：${knownKeys.size} 条`);
        for (const pv of packVersions) {
            if (!/^[\w.:-]+$/.test(pv.name) || !/[.:]/.test(pv.name)) continue;
            const langs = packLangs.get(pv.root);
            if (!langs) continue;
            const order = ['en_US', 'zh_CN', ...langs.keys()];
            for (const l of order) { const e = langs.get(l); if (e && e.map.has(pv.name)) { pv.name = e.map.get(pv.name).trim(); break; } }
        }
        for (const pv of packVersions) pv.name = pv.name.replace(/§./g, '').trim();

        if (typeof NS.ExtractContext !== 'function') throw new Error('页面文件没有完整加载（context.js），请刷新页面后重试');
        const ctx = new NS.ExtractContext({ knownKeys, existingValues, keyLangs, prevKeys, splitNewlines: opt.splitNewlines });
        ctx.sayMode = opt.sayMode;
        ctx.listCommandBlockNames = !!opt.listCommandBlockNames;
        ctx.includeHiddenItems = !!opt.includeHiddenItems;
        ctx.hiddenKeys = new Set();
        const info = { defs: { items: [], blocks: [], entities: [], spawnEggs: [] }, packRoot: '' };

        // 资源包界面里拿来比较的文字：(#title_text = 'Magic')、(#text = 'Advancements II')、('Foo' = #x)。
        // 这些文字翻译后比较就失败，自定义界面不再生效 → 脚本和界面里都保持原文
        ctx.uiCompared = new Set();
        ctx.uiPrefixes = new Set();
        for (const p of allFiles) {
            const pk = packOf(p);
            if (!pk || pk.type !== 'RP' || !/^ui\/.+\.json$/i.test(relOf(p, pk))) continue;
            let txt;
            try { txt = await fs.readText(p); } catch (e) { continue; }
            for (const m of txt.matchAll(/#[\w.]+\s*(=|-)\s*'([^']+)'|'([^']+)'\s*=\s*#[\w.]+/g)) {
                const v = (m[2] || m[3]).trim();
                if (v && /\p{L}{2,}/u.test(NS.stripFormatting(v))) ctx.uiCompared.add(v);
                // (#title_text - 'inspecting:')：界面减掉这个前缀再显示，前缀后面的文字照常翻译
                if (m[1] === '-' && m[2] && /[:|]$/.test(m[2])) ctx.uiPrefixes.add(m[2]);
            }
        }
        if (ctx.uiCompared.size) log(`[界面] 资源包界面里有 ${ctx.uiCompared.size} 段文字用来判断显示哪个自定义界面（如标题等于 'Magic'），这些文字保持原文不翻译`, 'warn');

        // 可见物品对应的方块 ID（同 ID 的物品，或 block_placer + replace_block_item 指向的方块）
        ctx.visibleItemBlocks = new Set();
        for (const p of allFiles) {
            const pk = packOf(p);
            if (!pk || pk.type !== 'BP' || !/^items\/.+\.json$/i.test(relOf(p, pk))) continue;
            let d;
            try { d = parseJsonLenient(await fs.readText(p)); } catch (e) { continue; }
            const it = d && d['minecraft:item'];
            if (!it || !it.description || typeof it.description.identifier !== 'string') continue;
            const mc = it.description.menu_category;
            if (mc && typeof mc === 'object' && (String(mc.category || '').toLowerCase() === 'none' || mc.is_hidden_in_commands === true)) continue;
            ctx.visibleItemBlocks.add(it.description.identifier);
            const bp = it.components && it.components['minecraft:block_placer'];
            if (bp && bp.replace_block_item) { const b = typeof bp.block === 'string' ? bp.block : bp.block && bp.block.name; if (b) ctx.visibleItemBlocks.add(b); }
        }

        // ---------------- 3. 预扫描 UI / 脚本 ----------------
        const uiData = [];
        const scriptInfos = new Map();
        const convertedScripts = new Set();
        let upgradedRuntimes = 0;
        for (const p of allFiles) {
            const pk = packOf(p);
            if (!pk) continue;
            const rel = relOf(p, pk);
            if (pk.type === 'RP' && /^ui\/.*\.json$/i.test(rel)) {
                const d = await readJson(p);
                if (d) uiData.push({ path: p, data: d });
            }
            if (opt.processScripts && pk.type === 'BP' && /^scripts\/.*\.(js|mjs)$/i.test(rel)) {
                const txt = await fs.readText(p);
                // 已经转换过的脚本（带运行时）：再处理会重复注入、把已登记的文字再提取一遍 → 跳过
                if (txt.includes('// ---- end i18n runtime ----')) {
                    convertedScripts.add(p);
                    // 运行时换成当前版本（修复旧版本的问题，如小地图字形画卡死）
                    const up = NS.upgradeRuntime ? NS.upgradeRuntime(txt) : null;
                    if (up) { pending.set(p, up); upgradedRuntimes++; }
                    continue;
                }
                scriptInfos.set(p, NS.collectScriptInfo(txt));
            }
        }
        if (convertedScripts.size) {
            const msg = `有 ${convertedScripts.size} 个脚本已经转换过（含 i18n 运行时），已原样保留不再处理${upgradedRuntimes ? `（其中 ${upgradedRuntimes} 个的运行时已更新到当前版本）` : ''}。这像是转换后的附加包：想修正提取结果，请用原始附加包重新转换`;
            log(msg, 'warn');
            ctx.warn(msg);
        }
        info.uiVarUsage = NS.collectUiVarUsage(uiData);
        const userMethods = new Set();
        let usesServerUi = false;
        const paramTexts = NS.collectParamTexts(scriptInfos);
        const crossDicts = NS.collectCrossFileDicts(scriptInfos, ctx);
        const asciiTexts = NS.collectAsciiPacketTexts ? NS.collectAsciiPacketTexts(scriptInfos) : new Map();
        if (asciiTexts.size) log(`[脚本] 发现固定长度 ASCII 的 HUD 数据包：${asciiTexts.size} 条流进它的文字无法本地化，已列入“无法本地化”`, 'warn');
        for (const si of scriptInfos.values()) {
            si.methods.forEach(m => userMethods.add(m));
            if (si.usesServerUi) usesServerUi = true;
        }
        const collidingMethods = new Set(Object.keys(NS.SCRIPT_SINKS).filter(n => userMethods.has(n)));
        const bpManifest = packs.find(p => p.type === 'BP');
        // @minecraft/server 2.2.0（1.21.110）起 ItemStack.setLore 接受 RawMessage，物品描述也能翻译
        const rawLore = packs.some(pk => (pk.manifest.dependencies || []).some(d => {
            if (!d || d.module_name !== '@minecraft/server') return false;
            const v = String(d.version || '');
            if (/^beta$/i.test(v)) return true;
            const m = /^(\d+)\.(\d+)/.exec(v);
            return !!m && (+m[1] > 2 || (+m[1] === 2 && +m[2] >= 2));
        }));
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

        // 固定写入简体中文：用户上传的译文 > 包自带的 zh_CN.lang > 脚本字典里的中文 > 游戏自带的中文名
        let bakeOf = null;
        if (opt.bakeZh) {
            const userLang = opt.bakeLang instanceof Map ? opt.bakeLang : (opt.bakeLang ? new Map(Object.entries(opt.bakeLang)) : null);
            const unesc = (v) => String(v).replace(/\\n/g, '\n');
            bakeOf = (k) => {
                if (userLang && userLang.has(k)) return unesc(userLang.get(k));
                for (const langs of packLangs.values()) { const e = langs.get('zh_CN'); if (e && e.map.has(k)) return unesc(e.map.get(k)); }
                const t = ctx.translations.get(k);
                if (t && t.has('zh_CN')) return t.get('zh_CN');
                const V = NS.VANILLA;
                return V && V.zh && V.zh[k] != null ? V.zh[k] : undefined;
            };
            log(`[脚本] 名字标签等只认纯文字的位置按简体中文固定写入${userLang ? `（使用上传的译文 ${userLang.size} 条）` : ''}`, 'warn');
        }

        // 包里自定义的物品 / 方块 / 实体 ID → 名称翻译键（给“把 ID 拼成英文名”的脚本函数用）
        // 名字键的值带了说明行（"Copper Pillar~LINEBREAK~~LINEBREAK~§9Bedrock Reimagined"，物品栏悬停时显示）：
        // 脚本拼名字（准星方块名、掉落物名…）时只要第一行 → 另建一个只有名字的键，各语言取各自译文的第一行
        const shortKeys = new Map();
        const nameOnly = (k) => {
            if (shortKeys.has(k)) return shortKeys.get(k);
            let res = k, src = null, lp = null;
            const per = new Map();
            for (const [root, langs] of packLangs) for (const [lang, e] of langs) {
                if (!e.map.has(k)) continue;
                const v = e.map.get(k);
                if (!per.has(lang)) per.set(lang, v);
                if (!lp || lang === 'en_US') { lp = e.path; if (lang === 'en_US' || src == null) src = v; }
            }
            const multi = (v) => /~LINEBREAK~|\\n|\n/.test(v);
            if (src != null && multi(src)) {
                const first = (v) => NS.stripFormatting(String(v).split(/~LINEBREAK~|\\n|\n/)[0]).trim();
                const name = first(src);
                if (name) {
                    res = `${k}.short`;
                    if (!ctx.entries.has(res)) {
                        ctx.entries.set(res, { value: name, file: lp, kind: 'name' });
                        ctx.keyFiles.set(res, new Set([lp]));
                        for (const [lang, v] of per) { const f = first(v); if (f) ctx.addTranslation(res, lang, f); }
                    }
                }
            }
            shortKeys.set(k, res);
            return res;
        };
        const idKeys = () => {
            const out = new Map();
            const has = (k) => knownKeys.has(k) || ctx.entries.has(k);
            for (const it of info.defs.items) { const k = [`item.${it.id}.name`, `item.${it.id}`].find(has); if (k) out.set(it.id, nameOnly(k)); }
            for (const b of info.defs.blocks) if (has(`tile.${b.id}.name`)) out.set(b.id, nameOnly(`tile.${b.id}.name`));
            for (const e of info.defs.entities) if (!out.has(e.id) && has(`entity.${e.id}.name`)) out.set(e.id, nameOnly(`entity.${e.id}.name`));
            return out;
        };

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
                if (!opt.processScripts || convertedScripts.has(p)) continue;
                const content = await fs.readText(p);
                const r = NS.processScript(content, p, ctx, {
                    info: scriptInfos.get(p), formSinksEnabled: usesServerUi, collidingMethods,
                    runtimeKey, injectRuntime: opt.injectRuntime, langFields, paramTexts: paramTexts.get(p), crossDict: crossDicts.get(p), asciiTexts, refSyntax: !!crossDicts.refSyntax, idKeys, rawLore, uiCompared: ctx.uiCompared, uiPrefixes: ctx.uiPrefixes, bakeOf,
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

        // 方块藏在创造栏里、但有同 ID（或 block_placer + replace_block_item 指向它）的可见物品代替它出现：
        // 名称照常提取 / 补全（如 sert:pink_lotus_waterlily）
        if (ctx.hiddenKeys && ctx.hiddenKeys.size) {
            for (const it of info.defs.items) {
                if (it.hidden) continue;
                for (const id of [it.id, it.placesBlock].filter(Boolean)) {
                    for (const k of [`item.${id}.name`, `item.${id}`, `tile.${id}.name`]) ctx.hiddenKeys.delete(k);
                }
            }
        }

        // ---------------- 5. 缺失的默认名称 ----------------
        const placeholders = [];
        if (opt.placeholderNames) {
            const addPh = (key, id, kind, file = '') => {
                if (knownKeys.has(key) || ctx.entries.has(key)) return;
                ctx.entries.set(key, { value: humanizeIdentifier(id), file, kind: 'placeholder' });
                if (file) ctx.keyFiles.set(key, new Set([file]));
                ctx.used.add(key);
                placeholders.push(key);
            };
            for (const b of info.defs.blocks) if (!b.hasName && !b.hidden) addPh(`tile.${b.id}.name`, b.id, 'block', b.file);
            for (const e of info.defs.entities) addPh(`entity.${e.id}.name`, e.id, 'entity', e.file);
            for (const id of info.defs.spawnEggs) if (!ctx.hiddenKeys.has(`item.spawn_egg.entity.${id}.name`)) addPh(`item.spawn_egg.entity.${id}.name`, id, 'spawn_egg', (info.defs.entities.find(e => e.id === id) || {}).file);
            for (const it of info.defs.items) {
                if (it.hasName || !it.isDataDriven || it.hidden) continue;   // 创造栏隐藏的物品多为技术用途，不生成占位名
                const cands = [`item.${it.id}.name`, `item.${it.id}`, `tile.${it.id}.name`];
                if (cands.some(k => knownKeys.has(k))) continue;
                const key = `item.${it.id}.name`;
                it.data['minecraft:item'].components['minecraft:display_name'] = { value: key };
                pending.set(it.file, JSON.stringify(it.data, null, 2));
                addPh(key, it.id, 'item', it.file);
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
        if (ctx.reusedPrev) log(`[lang] 沿用了 ${ctx.reusedPrev} 个上次转换生成的键（包里只有它们的译文），已有译文保留；附加包如果更新过内容，建议把上次输出的 en_US.lang 一起放回去，按原文核对更准确`, 'warn');

        // ---------------- 7. 行为包与资源包配对；没有资源包的行为包新建一个 ----------------
        // 多个附加包放在一起时，每个包的文字写进它自己的资源包，互不混合
        const uuidOf = (pk) => pk.manifest.header && String(pk.manifest.header.uuid || '').toLowerCase();
        const depsOf = (pk) => (Array.isArray(pk.manifest.dependencies) ? pk.manifest.dependencies : []).map(d => String(d.uuid || '').toLowerCase()).filter(Boolean);
        // 去掉 BP / RP 等后缀后的名字：Foo_BP ↔ Foo_RP、Foo/BP ↔ Foo/RP、Foo [BP] ↔ Foo [RP]
        const stripKind = (t) => String(t || '').toLowerCase().replace(/[\[\]()]/g, ' ').trim()
            .replace(/[\s_\-.\/]*(bp|rp|behaviou?r[\s_-]*packs?|resources?[\s_-]*packs?|behaviou?r|resources?|beh|res|b|r)$/i, '').replace(/[\s_\-.\/]+$/, '');
        // 比较最后一级文件夹名（behavior_packs/Foo_BP ↔ resource_packs/Foo_RP）；最后一级只是 BP/RP 时用整个路径
        const baseName = (pk) => stripKind(pk.root.split('/').pop()) || stripKind(pk.root) || stripKind(pk.manifest.header && pk.manifest.header.name);
        const pairOf = new Map();   // BP.root → RP
        {
            const bpsAll = packs.filter(p => p.type === 'BP'), rpsAll = packs.filter(p => p.type === 'RP');
            for (const bp of bpsAll) {
                let rp = rpsAll.find(r => depsOf(bp).includes(uuidOf(r))) || rpsAll.find(r => depsOf(r).includes(uuidOf(bp)));
                if (!rp) { const n = baseName(bp); if (n) rp = rpsAll.find(r => baseName(r) === n); }
                if (!rp && bpsAll.length === 1 && rpsAll.length === 1) rp = rpsAll[0];
                if (rp) pairOf.set(bp.root, rp);
            }
            if (packs.length > 2) for (const bp of bpsAll) log(`[配对] ${bp.root || '(根目录)'} → ${pairOf.has(bp.root) ? (pairOf.get(bp.root).root || '(根目录)') : '无资源包'}`);
        }
        // 每个新键属于哪些包
        const keyPacks = (k) => {
            const files = ctx.keyFiles.get(k) || new Set([ctx.entries.get(k) && ctx.entries.get(k).file].filter(Boolean));
            const set = new Set();
            for (const f of files) { const pk = packOf(f); if (pk) set.add(pk); }
            return set;
        };
        const unpairedBpsWithText = new Set();
        for (const k of ctx.entries.keys()) for (const pk of keyPacks(k)) if (pk.type === 'BP' && !pairOf.has(pk.root)) unpairedBpsWithText.add(pk);

        let rps = packs.filter(p => p.type === 'RP');
        let createdRP = null;
        const createdRPs = [];
        let restructured = false;
        for (const bpNeedingRp of (ctx.entries.size > 0 ? [...unpairedBpsWithText] : [])) {
            const bps = [bpNeedingRp];
            // 包在压缩包根目录（单个 .mcpack）→ 挪进子文件夹，才能和新资源包一起打成 .mcaddon
            const rootPack = packs.find(p => p.root === '');
            if (rootPack) {
                const newRoot = `${NS.sanitizeKeyPart(opt.baseName)}_BP`;
                for (const f of fs.list()) fs.move(f, `${newRoot}/${f}`);
                for (const rec of ctx.structureRecords || []) rec.file = `${newRoot}/${rec.file}`;
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
            const rpRoot = opt.newRpRoot ? opt.newRpRoot(bpNeedingRp) : packs.filter(p => p.type === 'BP').length > 1
                ? `${NS.sanitizeKeyPart(bpNeedingRp.root.split('/').pop() || opt.baseName)}_texts_RP`
                : `${NS.sanitizeKeyPart(opt.baseName)}_texts_RP`;
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
            createdRPs.push(createdRP);
            pairOf.set(bpNeedingRp.root, createdRP);
            rps = packs.filter(p => p.type === 'RP');
            log(`[新建] ${bpNeedingRp.root || '行为包'} 没有资源包，翻译只能放在资源包里 → 已新建 ${rpRoot}/ 并让行为包依赖它`, 'warn');
        }
        // 键 → 要写入的资源包
        const rpTargets = (k) => {
            const out = new Set();
            for (const pk of keyPacks(k)) {
                if (pk.type === 'RP') out.add(pk);
                else if (pairOf.has(pk.root)) out.add(pairOf.get(pk.root));
            }
            if (!out.size && rps.length) out.add(rps[0]);   // 找不到来源时退回第一个资源包
            return out;
        };

        // ---------------- 8. 写 lang ----------------
        // ---- 语言文件黑名单：模板残留的无效条目 ----
        // 键和值都与黑名单相同，且包里没有对应实体 / 没有引用这个键 → 从所有语言里删除
        const junkByPack = new Map();
        if (opt.removeJunkLang && NS.getLangBlacklist) {
            const bl = NS.getLangBlacklist();
            const definedIds = new Set([...info.defs.entities.map(e => e.id), ...info.defs.spawnEggs, ...info.defs.items.map(e => e.id), ...info.defs.blocks.map(e => e.id)]);
            let refText = null;
            const refs = async () => {
                if (refText === null) {
                    const parts = [];
                    for (const f of allFiles) if (/\.(json|js|mjs|mcfunction|material)$/i.test(f)) { try { parts.push(await fs.readText(f)); } catch (e) { /* 读不了的文件跳过 */ } }
                    refText = parts.join('\n');
                }
                return refText;
            };
            let total = 0;
            for (const pk of packs) {
                const langs = packLangs.get(pk.root);
                if (!langs) continue;
                const junk = new Set();
                for (const e of langs.values()) for (const [k, v] of e.map) {
                    if (junk.has(k)) continue;
                    const bv = bl.get(k);
                    if (bv == null || bv !== v.trim()) continue;
                    const m = /^(?:item\.spawn_egg\.)?entity\.(.+)\.name$/.exec(k);
                    if (m ? definedIds.has(m[1]) : (await refs()).includes(k)) continue;
                    junk.add(k);
                }
                if (junk.size) { junkByPack.set(pk.root, junk); total += junk.size; }
            }
            if (total) log(`[lang] 发现 ${total} 条模板残留的无效条目（别的包的刷怪蛋 / 实体名等），将从各语言文件中删除`, 'warn');
        }

        // ---- 上次转换生成、这次已经用不到的键（放回的译文 lang 里多出来的）：从各语言里删除 ----
        // 只看本工具生成的键（上次写在标记行之后的，或 script. 开头的）；改写后的文件里都找不到这个键名才删
        {
            const cand = new Set();
            for (const langs of packLangs.values()) for (const e of langs.values()) for (const k of e.map.keys()) {
                if (!(prevKeys.has(k) || /^script\./.test(k))) continue;
                if (ctx.entries.has(k) || ctx.claimed.has(k) || ctx.referenced.has(k)) continue;
                if (/^(item|tile|entity|action|pack|potion|enchantment|effect|biome|container|commands|death|chat|gui|options|menu|key|block|accessibility|tooltip|record|structure_block|hbui|xbox|selectWorld|createWorld)\./.test(k)) continue;
                cand.add(k);
            }
            if (cand.size) {
                const used = new Set();
                const scan = (t) => { const re = /[A-Za-z0-9_:.\-]{3,}/g; let m; while ((m = re.exec(t))) if (cand.has(m[0])) used.add(m[0]); };
                for (const f of allFiles) {
                    if (/\.lang$/i.test(f)) continue;
                    try {
                        if (pending.has(f)) scan(String(pending.get(f)));
                        else if (/\.(json|js|mjs|mcfunction|material|txt)$/i.test(f)) scan(await fs.readText(f));
                        else if (/\.(mcstructure|nbt)$/i.test(f) && fs.readBytes) { const b = await fs.readBytes(f); let t = ''; for (let i = 0; i < b.length; i += 65536) t += String.fromCharCode.apply(null, b.subarray(i, i + 65536)); scan(t); }
                    } catch (e) { /* 读不了的文件跳过 */ }
                }
                for (const [f, c] of pending) if (!/\.lang$/i.test(f) && !allFiles.includes(f)) scan(String(c));
                let n = 0;
                for (const pk of packs) {
                    const langs = packLangs.get(pk.root);
                    if (!langs) continue;
                    let junk = junkByPack.get(pk.root);
                    for (const e of langs.values()) for (const k of e.map.keys()) {
                        if (!cand.has(k) || used.has(k)) continue;
                        if (!junk) { junk = new Set(); junkByPack.set(pk.root, junk); }
                        if (!junk.has(k)) { junk.add(k); n++; }
                    }
                }
                if (n) log(`[lang] ${n} 个上次转换生成的键这次已经用不到（附加包更新后删掉或改了文字），将从各语言文件中删除`, 'warn');
            }
        }

        const existingUntranslated = new Map();   // 键 → { value, file, langs }
        const writeLangs = (pk, entries, isRP) => {
            const junk = junkByPack.get(pk.root) || new Set();
            const langs = packLangs.get(pk.root) || new Map();
            const texts = pk.root ? `${pk.root}/texts` : 'texts';
            // 脚本多语言表里的语言：只算写进这个包的键
            const ownTableLangs = new Set();
            if (isRP) for (const k of entries.keys()) { const t = ctx.translations.get(k); if (t) for (const l of t.keys()) ownTableLangs.add(l); }
            const langSet = new Set([...langs.keys(), ...opt.targetLangs, sourceLang, 'en_US', ...ownTableLangs]);
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
                    if (map.has(k) || junk.has(k)) continue;
                    // 脚本自带的多语言表里有这种语言的译文 → 直接使用
                    const tr = ctx.translations.get(k);
                    added.push(`${k}=${toLangValue(tr && tr.has(lang) ? tr.get(lang) : v)}`);
                }
                const filled = [];
                if (opt.fillMissing && isRP) {
                    for (const k of allExistingKeys) {
                        if (map.has(k) || entries.has(k) || ctx.hiddenKeys.has(k) || junk.has(k)) continue;
                        const v = fillFrom(k);
                        if (v != null) {
                            filled.push(`${k}=${v}`);
                            // 包里原有、但这个语言还没有译文的键：也放进翻译表，不然只翻新提取的会漏掉它们
                            if (!existingUntranslated.has(k)) existingUntranslated.set(k, { value: v, file: `${pk.root ? pk.root + "/" : ""}texts/${lang}.lang`, langs: new Set() });
                            existingUntranslated.get(k).langs.add(lang);
                        }
                    }
                }
                // 已有译文里 %1$s 和 %s 混用（游戏会显示成 “%3”）→ 自动改成全部带序号
                let raw = e ? e.raw : '';
                let fixedN = 0;
                if (e) raw = raw.replace(/^([^#\s=][^=\r\n]*=)([^\r\n]*)$/gm, (line, k, v) => {
                    const f = fixMixedPlaceholders(v);
                    if (f == null || f === v) return line;
                    fixedN++;
                    ctx.warn(`${e.path}: ${k.slice(0, -1)} 混用了 %1$s 和 %s，已改为 ${f}`);
                    return k + f;
                });
                let junkN = 0;
                if (e && junk.size) raw = raw.split('\n').filter((line) => {
                    const t = line.trimStart();
                    if (!t || t.startsWith('#')) return true;
                    const eq = line.indexOf('=');
                    if (eq <= 0 || !junk.has(line.slice(0, eq).trim())) return true;
                    junkN++;
                    return false;
                }).join('\n');
                if (!added.length && !filled.length && !fixedN && !junkN) { if (e) written.push(lang); continue; }
                let out = e ? raw.replace(/\s*$/, '\n') : '';
                if (added.length) out += `\n${MARK} 自动提取（源语言 ${sourceLang}${lang === sourceLang ? '' : '，待翻译'}）\n${added.join('\n')}\n`;
                if (filled.length) out += `\n${MARK} 从其他语言补全（待翻译）\n${filled.join('\n')}\n`;
                const path = e ? e.path : `${texts}/${lang}.lang`;
                pending.set(path, out);
                written.push(lang);
                log(`[lang] ${path}：新增 ${added.length}${filled.length ? `，补全 ${filled.length}` : ''}${fixedN ? `，修正占位符 ${fixedN}` : ''}${junkN ? `，删除无效条目 ${junkN}` : ''}`);
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
        const entriesByRp = new Map();
        for (const [k, v] of newEntries) for (const rp of rpTargets(k)) {
            if (!entriesByRp.has(rp.root)) entriesByRp.set(rp.root, new Map());
            entriesByRp.get(rp.root).set(k, v);
        }
        for (const pk of packs) {
            const own = ctx.packEntries.get(pk.root) || new Map();
            let entries;
            if (pk.type === 'RP') entries = new Map([...(entriesByRp.get(pk.root) || []), ...own]);
            else entries = own;
            if (!entries.size && !(pk.type === 'RP' && opt.fillMissing) && !junkByPack.has(pk.root)) continue;
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
        for (const [k, x] of existingUntranslated) if (!ctx.entries.has(k)) rows.push([k, NS.fromLangValue ? NS.fromLangValue(x.value) : x.value, x.file, 'existing', ...trLangs.map(() => '')]);
        if (existingUntranslated.size) log(`[lang] 包里原有的 ${existingUntranslated.size} 个键在目标语言里还没有译文（已先填入原文），一并列入翻译表`, 'warn');
        const stringsCsv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
        // 附加包里的结构：转换后可在编辑器里手动修改（用合并前的逐条列表）
        const structureSession = NS.makeAddonStructureSession ? NS.makeAddonStructureSession(ctx, opt) : null;
        // 同一文件、同一位置、同一文字只列一次（结构里堆叠的实体、交易表里重复的物品等），记录出现次数；
        // 带 ref 的合并后所有 ref 用 ; 连接，导入时一起写回
        {
            const seen = new Map();
            const merged = [];
            for (const u of ctx.untranslatable) {
                const k = `${u.file}\u0000${u.where}\u0000${u.text}`;
                if (seen.has(k)) { const f = seen.get(k); f.count++; if (u.ref) f.refs.push(u.ref); }
                else { const f = { ...u, count: 1, refs: u.ref ? [u.ref] : [] }; seen.set(k, f); merged.push(f); }
            }
            ctx.untranslatable = merged;
        }
        // 文件里的条目（战利品表 set_name、脚本 nameTag、say 命令……）：ref = F|序号，可在编辑器里改或导入翻译表写回
        ctx.untranslatable.forEach((u, i) => { if (!u.refs.length) u.refs.push(`F|${i}`); });
        const manualSession = makeAddonManualSession(ctx.untranslatable, structureSession);
        // 结构里的条目带 ref：在 translation 列填译文后可在编辑器里“导入翻译表”写回结构
        const untrRows = [['ref', 'file', 'where', 'text', 'reason', 'count', 'translation'], ...ctx.untranslatable.map(u => [u.refs.join(';'), u.file, u.where, u.text, u.reason, u.count, ''])];
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
        const sourceLangFile = [...ctx.entries].map(([k, e]) => `${k}=${toLangValue(e.value)}`).join('\n') + '\n'
            + (existingUntranslated.size ? '\n## 包里原有、目标语言还没有译文的条目\n' + [...existingUntranslated].filter(([k]) => !ctx.entries.has(k)).map(([k, x]) => `${k}=${x.value}`).join('\n') + '\n' : '');

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
            createdRPs: createdRPs.map(p => ({ root: p.root, uuid: p.manifest.header.uuid })),
            restructured,
            minVersion,
            packVersions,
        };
        return {
            ctx, summary, structureSession, manualSession,
            workbook: {
                'strings.csv': stringsCsv,
                'untranslatable.csv': untranslatableCsv,
                ...(inputCsv ? { 'input_aliases.csv': inputCsv } : {}),
                [`source_${sourceLang}.lang`]: sourceLangFile,
            },
        };
    }


    /**
     * 附加包的“需人工翻译”编辑会话：结构条目交给结构会话；文件里的条目（F|序号）
     * 在下载时按文件类型写回：JSON 按值替换、脚本按字符串字面量替换、其他文本按子串替换。
     */
    function makeAddonManualSession(list, structureSession) {
        const fileItems = list.filter(u => u.refs[0] && u.refs[0].startsWith('F|'));
        if (!fileItems.length && !structureSession) return null;
        const byRef = new Map(fileItems.map(u => [u.refs[0], u]));
        const values = new Map();      // F 引用 → 新文字
        const writtenVals = new Map(); // F 引用 → 已写进文件的文字
        const S = structureSession;
        const T = NS.NBT && NS.NBT.T;
        const editorList = [...(S ? S.ctx.untranslatable : []), ...fileItems.map(u => ({ ...u, ref: u.refs[0] }))];
        const ctxView = Object.create(S ? S.ctx : {});
        ctxView.untranslatable = editorList;
        const session = {
            records: S ? S.records : [], ctx: ctxView, hiddenCats: S ? S.hiddenCats : new Set(),
            get edits() { return (S ? S.edits : 0) + values.size; },
            set edits(v) { /* 由各自会话计数 */ },
            resolve(ref) {
                if (byRef.has(ref)) return { node: { t: T ? T.STRING : 8 }, path: [], rec: null };
                return S ? S.resolve(ref) : null;
            },
            getText(ref) {
                if (byRef.has(ref)) return values.has(ref) ? values.get(ref) : byRef.get(ref).text;
                return S ? S.getText(ref) : null;
            },
            setValue(ref, v) {
                if (byRef.has(ref)) { if (v === byRef.get(ref).text) values.delete(ref); else values.set(ref, v); return v; }
                return S.setValue(ref, v);
            },
            limitOf(ref) { return byRef.has(ref) ? null : (S && S.limitOf ? S.limitOf(ref) : null); },
            search(q, max) { return S ? S.search(q, max) : []; },
            get notice() { return S ? S.notice : null; },
            get structureChanged() { return S ? S.structureChanged : false; },
            workbook() {
                const rows = [['ref', 'file', 'where', 'text', 'reason', 'count', 'translation'],
                    ...list.filter(u => !session.hiddenCats.has(NS.worldCategoryOf ? NS.worldCategoryOf(u) : u.where))
                        .map(u => [u.refs.join(';'), u.file, u.where, u.text, u.reason, u.count, ''])];
                return { 'untranslatable.csv': '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') };
            },
            importCsv(text) {
                const rows = NS.worldParseCsv(String(text).replace(/^﻿/, ''));
                const head = rows[0] || [];
                const iRef = head.indexOf('ref'), iTr = head.indexOf('translation');
                const iText = head.indexOf('text'), iFile = head.indexOf('file');
                if (iRef < 0 || iTr < 0) throw new Error('表格缺少 ref 或 translation 列');
                let applied = 0, skipped = 0;
                const rest = [head];
                // 表格来自另一次转换（选项不同，序号对不上）：按原文 + 文件找回对应条目
                const norm = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n');
                const byText = new Map();
                for (const u of fileItems) { const k = u.file + '\u0000' + norm(u.text); if (!byText.has(k)) byText.set(k, []); byText.get(k).push(u.refs[0]); }
                for (const r of rows.slice(1)) {
                    const tr = r[iTr];
                    if (!r[iRef] || tr == null || tr === '') { skipped++; continue; }
                    const refs = String(r[iRef]).split(';').map(x => x.trim()).filter(Boolean);
                    const sRefs = [];
                    const txt = iText >= 0 ? norm(r[iText]) : null;
                    for (const ref of refs) {
                        if (!ref.startsWith('F|')) { sRefs.push(ref); continue; }
                        let targets = [ref];
                        if (txt != null && (!byRef.has(ref) || norm(byRef.get(ref).text) !== txt)) {
                            targets = (iFile >= 0 && byText.get(r[iFile] + '\u0000' + txt)) || [];
                        }
                        if (!targets.length) { skipped++; continue; }
                        for (const t of targets) { session.setValue(t, tr); applied++; }
                    }
                    if (sRefs.length) { const c = r.slice(); c[iRef] = sRefs.join(';'); rest.push(c); }
                }
                if (S && rest.length > 1) {
                    const res = S.importCsv(rest.map(r => r.map(csvCell).join(',')).join('\n'));
                    applied += res.applied; skipped += res.skipped;
                }
                return { applied, skipped };
            },
            /** 下载前写回：返回 { structures, files } */
            async applyTo(fs) {
                const structures = S ? S.applyTo(fs) : 0;
                const byFile = new Map();
                // 已经写回过一次（先下载、又改了）：从上次写进去的文字改起，改回原文也能写回
                for (const ref of new Set([...values.keys(), ...writtenVals.keys()])) {
                    const u = byRef.get(ref);
                    const cur = writtenVals.has(ref) ? writtenVals.get(ref) : u.text;
                    const to = values.has(ref) ? values.get(ref) : u.text;
                    if (cur === to) continue;
                    if (!byFile.has(u.file)) byFile.set(u.file, []);
                    byFile.get(u.file).push({ from: cur, to, sub: u.where.startsWith('/'), ref });
                }
                let files = 0, missed = 0;
                for (const [file, reps] of byFile) {
                    let src;
                    try { src = await fs.readText(file); } catch (e) { missed += reps.length; continue; }
                    const r = replaceInFile(file, src, reps);
                    missed += r.missed;
                    if (r.text !== src) { fs.writeText(file, r.text); files++; }
                    for (const x of (r.done || reps)) { if (x.to === byRef.get(x.ref).text) writtenVals.delete(x.ref); else writtenVals.set(x.ref, x.to); }
                }
                return { structures, files, missed };
            },
        };
        return session;
    }

    function replaceInFile(file, src, reps) {
        let missed = 0;
        const sub = (str) => {
            let out = str;
            for (const r of reps) {
                if (out === r.from) out = r.to;
                else if (r.sub && out.includes(r.from)) out = out.split(r.from).join(r.to);
            }
            return out;
        };
        const hit = new Set();
        const mark = (before, after) => { for (const r of reps) if (before !== after && (before === r.from || (r.sub && before.includes(r.from)))) hit.add(r); };
        if (/\.json$/i.test(file)) {
            const data = parseJsonLenient(src);
            if (data === undefined) return { text: src, missed: reps.length, done: [] };
            const walkJ = (v) => {
                if (typeof v === 'string') { const n = sub(v); mark(v, n); return n; }
                if (Array.isArray(v)) return v.map(walkJ);
                if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walkJ(v[k]); return v; }
                return v;
            };
            const out = walkJ(data);
            for (const r of reps) if (!hit.has(r)) missed++;
            return { text: hit.size ? JSON.stringify(out, null, 2) : src, missed, done: [...hit] };
        }
        if (/\.(m?js)$/i.test(file) && root.acorn) {
            let ast;
            try { ast = root.acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
            catch (e) { return { text: src, missed: reps.length, done: [] }; }
            const edits = [];
            const visit = (n, inReg) => {
                if (!n || typeof n.type !== 'string') return;
                if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object && n.callee.object.name === '__i18n') inReg = true;
                if (!inReg && n.type === 'Literal' && typeof n.value === 'string') {
                    const nv = sub(n.value);
                    if (nv !== n.value) { mark(n.value, nv); edits.push([n.start, n.end, JSON.stringify(nv)]); }
                } else if (!inReg && n.type === 'TemplateLiteral') {
                    for (const q of n.quasis) {
                        const v = q.value.cooked;
                        if (typeof v !== 'string') continue;
                        const nv = sub(v);
                        if (nv !== v) { mark(v, nv); edits.push([q.start, q.end, nv.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')]); }
                    }
                }
                for (const k in n) {
                    if (k === 'loc') continue;
                    const c = n[k];
                    if (Array.isArray(c)) c.forEach(x => visit(x, inReg));
                    else if (c && typeof c.type === 'string') visit(c, inReg);
                }
            };
            visit(ast, false);
            edits.sort((a, b) => b[0] - a[0]);
            let out = src;
            for (const [a, b, t] of edits) out = out.slice(0, a) + t + out.slice(b);
            for (const r of reps) if (!hit.has(r)) missed++;
            return { text: out, missed, done: [...hit] };
        }
        // 其他文本（.mcfunction 等）：按行替换
        const out = src.split('\n').map(line => { const n = sub(line); mark(line, n); return n; }).join('\n');
        for (const r of reps) if (!hit.has(r)) missed++;
        return { text: out, missed, done: [...hit] };
    }

    NS.runPipeline = runPipeline;
    NS.makeAddonManualSession = makeAddonManualSession;
    NS.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
    NS.detectSourceLang = detectSourceLang;
})(typeof globalThis !== 'undefined' ? globalThis : this);
