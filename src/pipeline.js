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
        removeJunkLang: true,          // 删除语言文件里模板残留的无效条目（见 lang-blacklist.js）     // 创造物品栏里不显示的物品 / 方块、不显示的刷怪蛋：默认不提取
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

        if (typeof NS.ExtractContext !== 'function') throw new Error('页面文件没有完整加载（context.js），请刷新页面后重试');
        const ctx = new NS.ExtractContext({ knownKeys, existingValues, splitNewlines: opt.splitNewlines });
        ctx.sayMode = opt.sayMode;
        ctx.listCommandBlockNames = !!opt.listCommandBlockNames;
        ctx.includeHiddenItems = !!opt.includeHiddenItems;
        ctx.hiddenKeys = new Set();
        const info = { defs: { items: [], blocks: [], entities: [], spawnEggs: [] }, packRoot: '' };

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
                if (!opt.processScripts || convertedScripts.has(p)) continue;
                const content = await fs.readText(p);
                const r = NS.processScript(content, p, ctx, {
                    info: scriptInfos.get(p), formSinksEnabled: usesServerUi, collidingMethods,
                    runtimeKey, injectRuntime: opt.injectRuntime, langFields, paramTexts: paramTexts.get(p), crossDict: crossDicts.get(p), asciiTexts,
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
                        if (v != null) filled.push(`${k}=${v}`);
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
            createdRPs: createdRPs.map(p => ({ root: p.root, uuid: p.manifest.header.uuid })),
            restructured,
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
                if (iRef < 0 || iTr < 0) throw new Error('表格缺少 ref 或 translation 列');
                let applied = 0, skipped = 0;
                const rest = [head];
                for (const r of rows.slice(1)) {
                    const tr = r[iTr];
                    if (!r[iRef] || tr == null || tr === '') { skipped++; continue; }
                    const refs = String(r[iRef]).split(';').map(x => x.trim()).filter(Boolean);
                    const sRefs = [];
                    for (const ref of refs) {
                        if (byRef.has(ref)) { session.setValue(ref, tr); applied++; } else sRefs.push(ref);
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
                for (const [ref, v] of values) {
                    const u = byRef.get(ref);
                    if (!byFile.has(u.file)) byFile.set(u.file, []);
                    byFile.get(u.file).push({ from: u.text, to: v, sub: u.where.startsWith('/') });
                }
                let files = 0, missed = 0;
                for (const [file, reps] of byFile) {
                    let src;
                    try { src = await fs.readText(file); } catch (e) { missed += reps.length; continue; }
                    const r = replaceInFile(file, src, reps);
                    missed += r.missed;
                    if (r.text !== src) { fs.writeText(file, r.text); files++; }
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
            if (data === undefined) return { text: src, missed: reps.length };
            const walkJ = (v) => {
                if (typeof v === 'string') { const n = sub(v); mark(v, n); return n; }
                if (Array.isArray(v)) return v.map(walkJ);
                if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walkJ(v[k]); return v; }
                return v;
            };
            const out = walkJ(data);
            for (const r of reps) if (!hit.has(r)) missed++;
            return { text: hit.size ? JSON.stringify(out, null, 2) : src, missed };
        }
        if (/\.(m?js)$/i.test(file) && root.acorn) {
            let ast;
            try { ast = root.acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
            catch (e) { return { text: src, missed: reps.length }; }
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
            return { text: out, missed };
        }
        // 其他文本（.mcfunction 等）：按行替换
        const out = src.split('\n').map(line => { const n = sub(line); mark(line, n); return n; }).join('\n');
        for (const r of reps) if (!hit.has(r)) missed++;
        return { text: out, missed };
    }

    NS.runPipeline = runPipeline;
    NS.makeAddonManualSession = makeAddonManualSession;
    NS.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
    NS.detectSourceLang = detectSourceLang;
})(typeof globalThis !== 'undefined' ? globalThis : this);
