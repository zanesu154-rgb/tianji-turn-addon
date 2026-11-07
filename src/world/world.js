/* ================================================================
 *  world/world.js —— 世界存档（.mcworld / .mctemplate）文本提取
 *
 *  可翻译（改成翻译键）：
 *    告示牌 / 悬挂告示牌 正反面   Text → {"rawtext":[{"translate":…}]}
 *    命令方块 / 命令方块矿车      title / titleraw / tellraw
 *    NPC                         名字 RawtextName、正文 InterativeText、按钮名、按钮命令
 *  只能记录（游戏按纯文本显示）：
 *    say / tell 命令、容器名、物品名、物品描述、成书、实体名字标签
 *
 *  写回：只在 db 当前日志末尾追加修改（见 leveldb.js），并在存档里新建一个资源包存放翻译。
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;
    const { NBT, LevelDB } = NS;
    const { T, child, getStr, setStr } = NBT;

    const isChunkTag = (k, tag) => (k.length === 9 || k.length === 13) && k[k.length - 1] === tag;
    const isActorKey = (k) => k.length >= 11 && String.fromCharCode(...k.subarray(0, 11)) === 'actorprefix';

    function rawJson(parts) {
        return JSON.stringify({ rawtext: parts });
    }

    /** 已经是 {"rawtext":…} JSON 的字符串 */
    function parseRawJson(s) {
        if (typeof s !== 'string' || !/^\s*\{\s*"rawtext"/.test(s)) return null;
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    /** 把一段文字转成 rawtext JSON 字符串；不需要翻译返回 null */
    function textToRaw(ctx, text, baseKey, meta) {
        const existing = parseRawJson(text);
        if (existing) return ctx.processRawMessage(existing, baseKey, meta) ? JSON.stringify(existing) : null;
        const parts = ctx.rawParts(text, baseKey, meta);
        return parts ? rawJson(parts) : null;
    }

    function posOf(c) {
        const x = child(c, 'x'), y = child(c, 'y'), z = child(c, 'z');
        return x && y && z ? `${x.v}_${y.v}_${z.v}` : 'unknown';
    }

    /** 物品 / 容器里玩家可见但不能翻译的文字 → 报告 */
    function reportItems(ctx, items, where) {
        if (!items || items.t !== T.LIST || items.v.et !== T.COMPOUND) return;
        for (const it of items.v.items) {
            const name = getStr(it, 'Name') || '';
            const tag = child(it, 'tag');
            if (!tag || tag.t !== T.COMPOUND) continue;
            const display = child(tag.v, 'display');
            if (display && display.t === T.COMPOUND) {
                const dn = getStr(display.v, 'Name');
                if (dn) ctx.report(where, `物品名（${name}）`, dn, '物品自定义名称不支持翻译键');
                const lore = child(display.v, 'Lore');
                if (lore && lore.t === T.LIST) lore.v.items.forEach(l => l && l.s && ctx.report(where, `物品描述（${name}）`, l.s, '物品描述不支持翻译键'));
            }
            const title = getStr(tag.v, 'title');
            if (title) ctx.report(where, '成书标题', title, '成书内容不支持翻译键');
            const pages = child(tag.v, 'pages');
            if (pages && pages.t === T.LIST && pages.v.et === T.COMPOUND) {
                pages.v.items.forEach((pg, i) => { const t = getStr(pg, 'text'); if (t) ctx.report(where, `成书第 ${i + 1} 页`, t, '成书内容不支持翻译键'); });
            }
            // 潜影盒等嵌套容器
            reportItems(ctx, child(tag.v, 'Items'), where);
        }
    }

    // ---------------- 方块实体 ----------------
    function processBlockEntity(ctx, c, where) {
        const id = getStr(c, 'id') || '';
        const pos = posOf(c);
        let changed = false;
        const meta = { file: `${where} ${id}@${pos}`, kind: 'world', scope: 'world', mode: 'display' };

        if (id === 'Sign' || id === 'HangingSign') {
            for (const side of ['FrontText', 'BackText']) {
                const st = child(c, side);
                if (!st || st.t !== T.COMPOUND) continue;
                const text = getStr(st.v, 'Text');
                if (!text) continue;
                const raw = textToRaw(ctx, text, `world.sign.${pos}.${side === 'FrontText' ? 'front' : 'back'}`, meta);
                if (raw) { setStr(st.v, 'Text', raw); changed = true; }
            }
            // 1.20 之前的旧格式：Text 直接在根上
            const old = getStr(c, 'Text');
            if (old) {
                const raw = textToRaw(ctx, old, `world.sign.${pos}`, meta);
                if (raw) { setStr(c, 'Text', raw); changed = true; }
            }
        }

        if (id === 'CommandBlock') {
            const cmd = getStr(c, 'Command');
            if (cmd) {
                const r = NS.translateCommand(cmd, ctx, `world.command.${pos}`, meta.file);
                if (r.changed) { setStr(c, 'Command', r.cmd); changed = true; }
            }
        }

        const cn = getStr(c, 'CustomName');
        if (cn && id !== 'CommandBlock') ctx.report(meta.file, '方块名称', cn, '容器/方块的自定义名称不支持翻译键');
        reportItems(ctx, child(c, 'Items'), meta.file);
        // 讲台上的书
        const book = child(c, 'book');
        if (book && book.t === T.COMPOUND) reportItems(ctx, { t: T.LIST, v: { et: T.COMPOUND, items: [book.v] } }, meta.file);
        return changed;
    }

    // ---------------- 实体 ----------------
    function processActor(ctx, c, where) {
        const ident = getStr(c, 'identifier') || '';
        const uid = child(c, 'UniqueID');
        const idPart = uid ? String(uid.v).replace('-', 'n') : 'x';
        const meta = { file: `${where} ${ident}#${idPart}`, kind: 'world', scope: 'world', mode: 'display' };
        let changed = false;

        if (ident === 'minecraft:npc') {
            const base = `world.npc.${idPart}`;
            const name = getStr(c, 'RawtextName');
            if (name) {
                const raw = textToRaw(ctx, name, `${base}.name`, meta);
                if (raw) { setStr(c, 'RawtextName', raw); changed = true; }
            }
            const text = getStr(c, 'InterativeText');
            if (text) {
                const raw = textToRaw(ctx, text, `${base}.text`, meta);
                if (raw) { setStr(c, 'InterativeText', raw); changed = true; }
            }
            const actionsStr = getStr(c, 'Actions');
            if (actionsStr) {
                let actions;
                try { actions = JSON.parse(actionsStr); } catch (e) { actions = null; }
                if (Array.isArray(actions)) {
                    let ach = false;
                    actions.forEach((a, i) => {
                        if (!a || typeof a !== 'object') return;
                        if (typeof a.button_name === 'string' && a.button_name) {
                            const raw = textToRaw(ctx, a.button_name, `${base}.button_${i}`, meta);
                            if (raw) { a.button_name = raw; ach = true; }
                        }
                        if (Array.isArray(a.data)) {
                            const lines = [];
                            a.data.forEach(d => {
                                if (d && typeof d.cmd_line === 'string') {
                                    const r = NS.translateCommand(d.cmd_line, ctx, `${base}.message`, meta.file);
                                    if (r.changed) { d.cmd_line = r.cmd; ach = true; }
                                    lines.push(d.cmd_line);
                                }
                            });
                            // "text" 是编辑界面里显示的命令文本，与 cmd_line 保持一致
                            if (ach && typeof a.text === 'string' && lines.length) a.text = lines.join('\n') + '\n';
                        }
                    });
                    if (ach) {
                        // 保持游戏的 JSON 风格（3 空格缩进、" : "）
                        setStr(c, 'Actions', JSON.stringify(actions, null, 3).replace(/": /g, '" : ') + '\n');
                        changed = true;
                    }
                }
            }
        }

        // 命令方块矿车
        const cmd = getStr(c, 'Command');
        if (cmd) {
            const r = NS.translateCommand(cmd, ctx, `world.command.${idPart}`, meta.file);
            if (r.changed) { setStr(c, 'Command', r.cmd); changed = true; }
        }

        const cn = getStr(c, 'CustomName');
        if (cn && ident !== 'minecraft:npc') ctx.report(meta.file, '实体名字标签', cn, '实体名称只能是纯文本，不支持翻译键');
        for (const f of ['Armor', 'Mainhand', 'Offhand', 'ChestItems', 'Items', 'Inventory']) reportItems(ctx, child(c, f), meta.file);
        return changed;
    }

    // ---------------- 主流程 ----------------
    /**
     * fs 接口同 pipeline.js；另需 readBytes(path) → Promise<Uint8Array>、writeBytes(path, u8)
     */
    async function runWorldPipeline(fs, userOptions = {}, log = () => {}) {
        const opt = { sourceLang: 'auto', targetLangs: ['en_US', 'zh_CN'], splitNewlines: true, baseName: 'world', ...userOptions };
        const all = fs.list();
        const levelDat = all.filter(p => /(^|\/)level\.dat$/.test(p)).sort((a, b) => a.length - b.length)[0];
        if (!levelDat) throw new Error('没有找到 level.dat，这不是世界存档');
        const rootDir = levelDat.replace(/level\.dat$/, '');
        const dbDir = rootDir + 'db/';
        const dbFiles = new Map();
        for (const p of all) if (p.startsWith(dbDir) && !p.slice(dbDir.length).includes('/')) dbFiles.set(p.slice(dbDir.length), await fs.readBytes(p));
        if (!dbFiles.size) throw new Error('存档里没有 db 文件夹');

        let levelName = opt.baseName;
        if (all.includes(rootDir + 'levelname.txt')) levelName = (await fs.readText(rootDir + 'levelname.txt')).trim() || levelName;
        log(`[存档] ${levelName}  db 文件 ${dbFiles.size} 个`);

        const db = await LevelDB.openDb(dbFiles, (k) => isChunkTag(k, 49) || isChunkTag(k, 50) || isActorKey(k));
        log(`[数据库] 有效数据表 ${db.info.tables} 个，当前日志 ${db.info.currentLog || '无'}，最新序列号 ${db.info.lastSeq}`);

        const ctx = new NS.ExtractContext({ splitNewlines: opt.splitNewlines });
        const puts = [];
        let nBE = 0, nActor = 0, nChanged = 0;
        for (const e of db.entries()) {
            const isBE = isChunkTag(e.key, 49);
            const isEntityList = isChunkTag(e.key, 50);
            let tags;
            try { tags = NBT.readAll(e.value); } catch (err) { log(`[跳过] 无法解析的记录：${err.message}`, 'warn'); continue; }
            let changed = false;
            for (const tg of tags) {
                if (tg.t !== T.COMPOUND) continue;
                if (isBE) { nBE++; if (processBlockEntity(ctx, tg.v, '方块实体')) changed = true; }
                else { nActor++; if (processActor(ctx, tg.v, isEntityList ? '实体(旧)' : '实体')) changed = true; }
            }
            if (changed) {
                puts.push({ key: e.key, value: NBT.writeAll(tags) });
                nChanged++;
            }
        }
        log(`扫描方块实体 ${nBE} 个、实体 ${nActor} 个；修改记录 ${nChanged} 条，提取文本 ${ctx.entries.size} 条`);

        // ---- 写回数据库 ----
        if (puts.length) {
            const r = LevelDB.appendPuts(dbFiles, db, puts);
            fs.writeBytes(dbDir + r.name, r.bytes);
            // 自检：重新打开，确认每条修改都能读回
            const check = new Map(dbFiles); check.set(r.name, r.bytes);
            const db2 = await LevelDB.openDb(check, (k) => isChunkTag(k, 49) || isChunkTag(k, 50) || isActorKey(k));
            const bad = puts.filter(pu => { const v = db2.get(pu.key); return !v || v.length !== pu.value.length || v.some((x, i) => x !== pu.value[i]); });
            if (bad.length) throw new Error(`写回自检失败（${bad.length} 条），已中止，未生成文件`);
            log(`[写回] 追加到 db/${r.name}，并已重新读取校验 ${puts.length} 条`);
        }

        // ---- 资源包 ----
        const values = [...ctx.entries.values()].map(e => e.value);
        const sourceLang = opt.sourceLang === 'auto' ? NS.detectSourceLang(values) : opt.sourceLang;
        let packDir = null;
        if (ctx.entries.size) {
            const uuid = () => (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
                : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => { const r = Math.random() * 16 | 0; return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
            const packUuid = uuid();
            const folder = /^[\x20-\x7e]+$/.test(levelName) ? `${NS.sanitizeKeyPart(levelName)}_texts` : 'world_texts';
            packDir = `${rootDir}resource_packs/${folder}/`;
            const manifest = {
                format_version: 2,
                header: { name: 'pack.name', description: 'pack.description', uuid: packUuid, version: [1, 0, 0], min_engine_version: [1, 20, 0] },
                modules: [{ type: 'resources', uuid: uuid(), version: [1, 0, 0] }],
            };
            fs.writeText(packDir + 'manifest.json', JSON.stringify(manifest, null, 2));
            const langs = [...new Set([...opt.targetLangs, sourceLang, 'en_US'])];
            const body = [...ctx.entries].map(([k, e]) => `${k}=${NS.toLangValue(e.value)}`).join('\n');
            for (const l of langs) {
                const head = `pack.name=${levelName} - Texts\npack.description=Translations for ${levelName}\n\n## ==== addon-i18n 自动提取（源语言 ${sourceLang}${l === sourceLang ? '' : '，待翻译'}） ====\n`;
                fs.writeText(`${packDir}texts/${l}.lang`, head + body + '\n');
            }
            fs.writeText(`${packDir}texts/languages.json`, JSON.stringify(langs, null, 2));
            // 登记到存档
            const wrp = rootDir + 'world_resource_packs.json';
            let list = [];
            if (all.includes(wrp)) { const d = NS.parseJsonLenient(await fs.readText(wrp)); if (Array.isArray(d)) list = d; }
            list.push({ pack_id: packUuid, version: [1, 0, 0] });
            fs.writeText(wrp, JSON.stringify(list, null, 2));
            log(`[资源包] 新建 ${packDir}，语言 ${langs.join(', ')}，已登记到 world_resource_packs.json`);
        }

        // ---- 翻译表 ----
        const csv = (rows) => '﻿' + rows.map(r => r.map(x => { const t = String(x == null ? '' : x); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
        const workbook = {
            'strings.csv': csv([['key', 'source_text', 'location', 'type'], ...[...ctx.entries].map(([k, e]) => [k, e.value, e.file, e.kind])]),
            'untranslatable.csv': csv([['location', 'where', 'text', 'reason'], ...ctx.untranslatable.map(u => [u.file, u.where, u.text, u.reason])]),
            [`source_${sourceLang}.lang`]: [...ctx.entries].map(([k, e]) => `${k}=${NS.toLangValue(e.value)}`).join('\n') + '\n',
        };
        return {
            ctx, workbook,
            summary: {
                packs: [], processedFiles: nChanged, newKeys: ctx.entries.size, packKeys: 0, placeholders: 0,
                untranslatable: ctx.untranslatable.length, warnings: ctx.warnings, missingRefs: [], sourceLang,
                createdRP: packDir, restructured: false, inputGroups: 0, world: true,
            },
        };
    }

    NS.runWorldPipeline = runWorldPipeline;
})(typeof globalThis !== 'undefined' ? globalThis : this);
