/* ================================================================
 *  world/world.js —— 世界存档（.mcworld / .mctemplate）文本提取与编辑
 *
 *  可翻译（改成翻译键）：
 *    告示牌 / 悬挂告示牌 正反面   Text → {"rawtext":[{"translate":…}]}
 *    命令方块 / 命令方块矿车      title / titleraw / tellraw
 *    NPC                         名字 RawtextName、正文 InterativeText、按钮名、按钮命令
 *  只能记录（游戏按纯文本显示，可在 NBT 编辑器里手动改）：
 *    say / tell 命令、容器名、物品名、物品描述、成书、实体名字标签
 *
 *  流程分两步：
 *    openWorld()   读取存档 → 自动转换（只改内存）→ 返回会话，可继续手动编辑
 *    session.build() 把所有改动写回：db 当前日志末尾追加一条记录 + level.dat + 新资源包
 *
 *  每条记录 rec = { id, kind: 'block'|'actor'|'level', key, label, tags, dirty }
 *  NBT 位置 path = [根标签序号, 子名字 | 列表下标, …]，引用 ref = `${rec.id}|${JSON.stringify(path)}`
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;
    const { NBT, LevelDB } = NS;
    const { T, child, getStr } = NBT;

    const isChunkTag = (k, tag) => (k.length === 9 || k.length === 13) && k[k.length - 1] === tag;
    const isActorKey = (k) => k.length >= 11 && String.fromCharCode(...k.subarray(0, 11)) === 'actorprefix';
    const STRUCT_PREFIX = 'structuretemplate';
    const isStructKey = (k) => k.length > STRUCT_PREFIX.length && String.fromCharCode(...k.subarray(0, STRUCT_PREFIX.length)) === STRUCT_PREFIX;
    // 玩家数据：本地玩家 ~local_player，多人存档里的其他玩家 player_server_… / player_…
    const keyText = (k, n) => String.fromCharCode(...k.subarray(0, Math.min(n, k.length)));
    const isPlayerKey = (k) => keyText(k, 13) === '~local_player' || keyText(k, 7) === 'player_';
    const wantKey = (k) => isChunkTag(k, 49) || isChunkTag(k, 50) || isActorKey(k) || isStructKey(k) || isPlayerKey(k);

    // ---------------- NBT 路径 ----------------
    /** 按路径取节点：返回 { t, v, set(v) } */
    function nodeAt(rec, path) {
        let entry = rec.tags[path[0]];
        if (!entry) return null;
        let setter = (v) => { entry.v = v; };
        for (let i = 1; i < path.length; i++) {
            const seg = path[i];
            if (entry.t === T.COMPOUND) {
                const c = entry.v.find(x => x.n === seg);
                if (!c) return null;
                entry = c;
                setter = (v) => { c.v = v; };
            } else if (entry.t === T.LIST) {
                const list = entry.v;
                if (typeof seg !== 'number' || seg >= list.items.length) return null;
                const idx = seg;
                entry = { t: list.et, v: list.items[idx] };
                setter = (v) => { list.items[idx] = v; };
            } else return null;
        }
        return { t: entry.t, v: entry.v, set: setter };
    }

    const NUM_TYPES = new Set([T.BYTE, T.SHORT, T.INT, T.LONG, T.FLOAT, T.DOUBLE]);
    const LIMITS = { [T.BYTE]: [-128, 127], [T.SHORT]: [-32768, 32767], [T.INT]: [-2147483648, 2147483647] };

    /** 把编辑框里的文字转换成该类型的值；不合法抛错 */
    function parseValue(t, text) {
        if (t === T.STRING) return new NBT.NbtString(String(text), null);
        if (t === T.LONG) { if (!/^-?\d+$/.test(text.trim())) throw new Error('需要整数'); return BigInt(text.trim()); }
        if (t === T.FLOAT || t === T.DOUBLE) { const n = Number(text); if (!Number.isFinite(n)) throw new Error('需要数字'); return n; }
        if (LIMITS[t]) {
            if (!/^-?\d+$/.test(text.trim())) throw new Error('需要整数');
            const n = Number(text); const [lo, hi] = LIMITS[t];
            if (n < lo || n > hi) throw new Error(`范围 ${lo} ~ ${hi}`);
            return n;
        }
        throw new Error('该类型不能直接编辑');
    }

    function displayValue(t, v) {
        if (t === T.STRING) return v.s;
        if (t === T.LONG) return v.toString();
        return String(v);
    }


    // ---------------- 游戏的文本长度限制 ----------------
    // 成书：每页 256 字符、14 行，整本 50 页；书名 16 字符（基岩版）
    const BOOK_PAGE_MAX = 256, BOOK_PAGE_LINES = 14, BOOK_MAX_PAGES = 50, BOOK_TITLE_MAX = 16;

    /** 路径是否是成书的某一页 / 书名 */
    function bookField(path) {
        const n = path.length;
        if (n >= 3 && path[n - 1] === 'text' && typeof path[n - 2] === 'number' && path[n - 3] === 'pages') return 'page';
        if (n >= 2 && path[n - 1] === 'title' && path[n - 2] === 'tag') return 'title';
        return null;
    }

    /** 把超长文本切成若干页：每页 ≤256 字符、≤14 行，尽量在换行、句末、空格处断开 */
    function splitPages(text) {
        const pages = [];
        let rest = text;
        while (rest.length) {
            let take = Math.min(rest.length, BOOK_PAGE_MAX);
            let chunk = rest.slice(0, take);
            const lines = chunk.split('\n');
            if (lines.length > BOOK_PAGE_LINES) { chunk = lines.slice(0, BOOK_PAGE_LINES).join('\n'); take = chunk.length; }
            if (take < rest.length) {
                // 在后半段里找最后一个合适的断点
                const min = Math.floor(take * 0.5);
                let cut = -1;
                for (const re of [/\n/g, /[。！？.!?]\s*/g, /[，,；;、]\s*/g, /\s+/g]) {
                    let m;
                    re.lastIndex = 0;
                    while ((m = re.exec(chunk))) { const end = m.index + m[0].length; if (end >= min && end <= take) cut = end; }
                    if (cut > 0) break;
                }
                if (cut > 0) take = cut;
            }
            pages.push(rest.slice(0, take).replace(/\n$/, ''));
            rest = rest.slice(take);
        }
        return pages.length ? pages : [''];
    }

    // ---------------- 自动转换 ----------------
    function rawJson(parts) { return JSON.stringify({ rawtext: parts }); }
    function parseRawJson(s) {
        if (typeof s !== 'string' || !/^\s*\{\s*"rawtext"/.test(s)) return null;
        try { return JSON.parse(s); } catch (e) { return null; }
    }
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

    /** 处理一条记录里的一个根复合标签 */
    /** 处理位于 base 路径的一个方块实体（kind='block'）或实体（kind='actor'） */
    function convertCompound(ctx, rec, base, kind) {
        const c = nodeAt(rec, base).v;
        let changed = false;
        const P = (...segs) => [...base, ...segs];
        const setS = (path, s) => { nodeAt(rec, path).set(new NBT.NbtString(s, null)); changed = true; };
        const report = (path, where, text, reason) => {
            // 格式码标记（§u§a§p）、技术 ID、数字、已是翻译键的名字不需要人工翻译
            if (typeof text !== 'string' || ctx.isKey(text)) return;
            // 作者写成了翻译键（{"rawtext":[{"translate":…}]}）：游戏内实测物品描述 / 名称不认，显示键名或消失 → 照常列出并说明
            if (/^\s*\{[\s\S]*"(rawtext|translate)"[\s\S]*\}\s*$/.test(text)) {
                try { const j = JSON.parse(text); if (j && (Array.isArray(j.rawtext) || typeof j.translate === 'string')) reason = '作者写成了翻译键，但这里游戏不支持（会显示键名 / 拿进背包后消失），需要改成纯文字'; } catch (e) { /* 不是 JSON */ }
            }
            const plain = NS.stripFormatting(text).trim();
            if (!NS.hasLetters(plain) || (/^[\w.:-]+$/.test(plain) && /[_:]/.test(plain))) return;
            ctx.untranslatable.push({ file: label, where, text, reason, ref: `${rec.id}|${JSON.stringify(path)}` });
        };
        const label = unitLabel(rec, c, kind);
        // 键名前缀：存档用 world，结构用 structure.<名字>（不同结构的内部坐标都从 0 开始）
        const kp = rec.kind === 'structure' ? `structure.${NS.sanitizeKeyPart(rec.name || 'unnamed')}` : 'world';
        const meta = { file: label, kind: 'world', scope: 'world', mode: 'display' };
        const cmd = (path, baseKey, sender) => {
            const s = getStr(nodeAt(rec, path.slice(0, -1)).v, path[path.length - 1]);
            if (!s) return;
            const before = ctx.untranslatable.length;
            const r = NS.translateCommand(s, ctx, baseKey, label, { sender });
            if (r.changed) setS(path, r.cmd);
            // say / tell 等报告补上位置
            for (let i = before; i < ctx.untranslatable.length; i++) ctx.untranslatable[i].ref = `${rec.id}|${JSON.stringify(path)}`;
        };
        // 成书正文 → 翻译键（游戏内实测有效）。存储的 JSON 受每页 256 字符限制，超长时退回为单个键
        const bookPage = (path, text, keyBase, where) => {
            if (!text) return;
            if (parseRawJson(text)) { const ex = parseRawJson(text); if (ctx.processRawMessage(ex, keyBase, meta)) setS(path, JSON.stringify(ex)); return; }
            // 先估算按行拆分后的 JSON 长度，超出就直接整页一个键（避免分配用不到的键）
            const nLines = text.split('\n').length;
            const est = 16 + nLines * (keyBase.length + 26) + (nLines - 1) * 14;
            const parts = ctx.rawParts(text, keyBase, est > BOOK_PAGE_MAX - 10 ? { ...meta, noSplit: true } : meta);
            if (!parts) return;
            let raw = rawJson(parts);
            if (est > BOOK_PAGE_MAX - 10 && nLines > 1) ctx.warn(`${label}: ${where} 行数较多，整页使用一个翻译键（换行写作 \\n）`);
            if (raw.length > BOOK_PAGE_MAX) {
                // 行数太多导致 JSON 过长：整页用一个键（换行在 lang 中写作 \n）
                const one = ctx.rawParts(text, keyBase, { ...meta, noSplit: true });
                raw = one ? rawJson(one) : raw;
                if (raw.length > BOOK_PAGE_MAX) { report(path, where, text, '成书页面过长，无法改为翻译键'); return; }
                ctx.warn(`${label}: ${where} 行数较多，整页使用一个翻译键（换行写作 \\n）`);
            }
            setS(path, raw);
        };
        const items = (path, keyBase) => {
            const list = nodeAt(rec, path);
            if (!list || list.t !== T.LIST || list.v.et !== T.COMPOUND) return;
            list.v.items.forEach((it, i) => {
                const slot = child(it, 'Slot');
                oneItem(it, [...path, i], `${keyBase}.s${slot ? slot.v : i}`);
            });
        };
        // 单个物品：展示框 / 荧光展示框的 Item、掉落物实体的 Item、营火 Item1~4、饰纹陶罐 item 等
        const singleItems = (keyBase) => {
            for (const f of ['Item', 'item', 'Item1', 'Item2', 'Item3', 'Item4']) {
                const nd = child(c, f);
                if (nd && nd.t === T.COMPOUND) oneItem(nd.v, P(f), `${keyBase}.${f.toLowerCase()}`);
            }
        };
        const oneItem = (it, ipath, kb) => {
            {
                const path = ipath.slice(0, -1), i = ipath[ipath.length - 1];
                const name = getStr(it, 'Name') || '';
                const tag = child(it, 'tag');
                if (!tag || tag.t !== T.COMPOUND) return;
                const display = child(tag.v, 'display');
                if (display && display.t === T.COMPOUND) {
                    const dn = getStr(display.v, 'Name');
                    if (dn) report([...path, i, 'tag', 'display', 'Name'], `物品名（${name}）`, dn, '物品自定义名称不支持翻译键');
                    const lore = child(display.v, 'Lore');
                    if (lore && lore.t === T.LIST && lore.v.et === T.STRING) lore.v.items.forEach((l, j) => l.s && !/^(?:\u00a7.)*\(\+DATA\)(?:\u00a7.)*$/.test(l.s.trim()) && report([...path, i, 'tag', 'display', 'Lore', j], `物品描述（${name}）`, l.s, '物品描述不支持翻译键'));
                }
                const title = getStr(tag.v, 'title');
                if (title) report([...path, i, 'tag', 'title'], '成书标题', title, '成书标题暂不确定是否支持翻译键');
                const pages = child(tag.v, 'pages');
                if (pages && pages.t === T.LIST && pages.v.et === T.COMPOUND) {
                    const written = name === 'minecraft:written_book';
                    pages.v.items.forEach((pg, j) => {
                        const t = getStr(pg, 'text');
                        if (!t) return;
                        const pp = [...path, i, 'tag', 'pages', j, 'text'];
                        // 书与笔（未签名）玩家还能编辑，改成翻译键会在编辑界面显示代码 → 只记录
                        if (written) bookPage(pp, t, `${kb}.p${j + 1}`, `成书第 ${j + 1} 页`);
                        else report(pp, `书与笔第 ${j + 1} 页`, t, '书与笔（未签名）玩家还可编辑，不改为翻译键');
                    });
                }
                items([...path, i, 'tag', 'Items'], kb);   // 潜影盒等嵌套容器
            }
        };

        if (kind === 'block') {
            const id = getStr(c, 'id') || '';
            const pos = posOf(c);
            if (id === 'Sign' || id === 'HangingSign') {
                for (const side of ['FrontText', 'BackText']) {
                    const st = child(c, side);
                    if (!st || st.t !== T.COMPOUND) continue;
                    const text = getStr(st.v, 'Text');
                    if (!text) continue;
                    const raw = textToRaw(ctx, text, `${kp}.sign.${pos}.${side === 'FrontText' ? 'front' : 'back'}`, meta);
                    if (raw) setS(P(side, 'Text'), raw);
                }
                const old = getStr(c, 'Text');   // 1.20 之前的旧格式
                if (old) { const raw = textToRaw(ctx, old, `${kp}.sign.${pos}`, meta); if (raw) setS(P('Text'), raw); }
            }
            // 命令方块执行 say 时，发送者名是它自己的名字（没起名时为 @）
            // 发送者名：say / me 转成 tellraw 后它在 rawtext 里，可以用翻译键（同名的命令方块共用一个键）
            if (id === 'CommandBlock') cmd(P('Command'), `${kp}.command.${pos}`, () => {
                const nm = getStr(c, 'CustomName') || '@';
                return nm !== '@' && NS.hasLetters(NS.stripFormatting(nm)) ? { translate: ctx.alloc(`${kp}.sender`, nm, meta) } : { text: nm };
            });
            const cn = getStr(c, 'CustomName');
            if (cn && id === 'CommandBlock') { if (ctx.listCommandBlockNames) report(P('CustomName'), '命令方块名称', cn, '命令方块名称（say 等命令输出时显示的发送者名）不支持翻译键'); }
            else if (cn) report(P('CustomName'), '方块名称', cn, '容器/方块的自定义名称不支持翻译键');
            items(P('Items'), `${kp}.book.${pos}`);
            singleItems(`${kp}.book.${pos}`);
            if (child(c, 'book')) {
                // 讲台上的书：book 是单个物品
                const bk = child(c, 'book');
                const pages = bk.t === T.COMPOUND && child(bk.v, 'tag') && child(child(bk.v, 'tag').v, 'pages');
                const btitle = bk.t === T.COMPOUND && child(bk.v, 'tag') && getStr(child(bk.v, 'tag').v, 'title');
                if (btitle) report(P('book', 'tag', 'title'), '讲台书标题', btitle, '成书标题暂不确定是否支持翻译键');
                if (pages && pages.t === T.LIST && pages.v.et === T.COMPOUND) {
                    const written = getStr(bk.v, 'Name') !== 'minecraft:writable_book';
                    pages.v.items.forEach((pg, j) => {
                        const t = getStr(pg, 'text');
                        if (!t) return;
                        if (written) bookPage(P('book', 'tag', 'pages', j, 'text'), t, `${kp}.book.${pos}.lectern.p${j + 1}`, `讲台书第 ${j + 1} 页`);
                        else report(P('book', 'tag', 'pages', j, 'text'), `讲台书与笔第 ${j + 1} 页`, t, '书与笔（未签名）玩家还可编辑，不改为翻译键');
                    });
                }
            }
        } else if (kind === 'actor') {
            const ident = getStr(c, 'identifier') || '';
            const uid = child(c, 'UniqueID');
            const idPart = uid ? String(uid.v).replace('-', 'n') : 'x';
            // 自定义 NPC（如 low:npc，runtime_identifier 为 minecraft:npc）：按是否带 NPC 数据判断，不只看 ID
            const isNpc = ident === 'minecraft:npc' || ['InterativeText', 'RawtextName', 'Actions'].some(k => getStr(c, k) != null);
            if (isNpc) {
                const base = `${kp}.npc.${idPart}`;
                const name = getStr(c, 'RawtextName');
                if (name) { const raw = textToRaw(ctx, name, `${base}.name`, meta); if (raw) setS(P('RawtextName'), raw); }
                const text = getStr(c, 'InterativeText');
                if (text) { const raw = textToRaw(ctx, text, `${base}.text`, meta); if (raw) setS(P('InterativeText'), raw); }
                const actionsStr = getStr(c, 'Actions');
                let actions = null;
                try { actions = actionsStr ? JSON.parse(actionsStr) : null; } catch (e) { actions = null; }
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
                            let lch = false;
                            a.data.forEach(d => {
                                if (d && typeof d.cmd_line === 'string') {
                                    const r = NS.translateCommand(d.cmd_line, ctx, `${base}.message`, label);
                                    if (r.changed) { d.cmd_line = r.cmd; lch = true; ach = true; }
                                    lines.push(d.cmd_line);
                                }
                            });
                            if (lch && typeof a.text === 'string' && lines.length) a.text = lines.join('\n') + '\n';
                        }
                    });
                    if (ach) setS(P('Actions'), JSON.stringify(actions, null, 3).replace(/": /g, '" : ') + '\n');
                }
            }
            if (getStr(c, 'Command')) cmd(P('Command'), `${kp}.command.${idPart}`);   // 命令方块矿车
            const cn = getStr(c, 'CustomName');
            if (cn && !isNpc && (ident !== 'minecraft:command_block_minecart' || ctx.listCommandBlockNames)) report(P('CustomName'), ident === 'minecraft:command_block_minecart' ? '命令方块名称' : '实体名字标签', cn, '实体名称只能是纯文本，不支持翻译键');
            const who = rec.kind === 'player' ? 'player' : idPart;
            for (const f of ['Armor', 'Mainhand', 'Offhand', 'ChestItems', 'Items', 'Inventory', 'EnderChestInventory', 'PlayerUIItems']) items(P(f), `${kp}.book.${who}.${f.toLowerCase()}`);
            singleItems(`${kp}.book.${who}`);   // 掉落物（minecraft:item）等
        }
        return changed;
    }

    /** 方块实体 / 实体的显示名称 */
    function unitLabel(rec, c, kind) {
        if (rec && rec.kind === 'player') return `玩家：${rec.name}`;
        const prefix = rec && rec.kind === 'structure' ? `[${rec.name}] ` : '';
        if (!Array.isArray(c)) return prefix + kind;
        if (kind === 'block') {
            const id = getStr(c, 'id') || '?';
            const x = child(c, 'x'), y = child(c, 'y'), z = child(c, 'z');
            return `${prefix}${id} @ ${x ? x.v : '?'}, ${y ? y.v : '?'}, ${z ? z.v : '?'}`;
        }
        const ident = (getStr(c, 'identifier') || '?').replace(/^minecraft:/, '');
        const name = getStr(c, 'CustomName');
        const pos = child(c, 'Pos');
        const p = pos && pos.t === T.LIST ? pos.v.items.map(n => Math.floor(n)).join(', ') : '';
        return `${prefix}${ident}${name ? ` “${name}”` : ''}${p ? ` @ ${p}` : ''}`;
    }

    /**
     * 一条记录里需要处理的单元：[{ base: 路径, kind }]
     *  - 方块实体 / 实体记录：每个根标签一个（一个区块的方块实体存在同一条记录里）
     *  - 结构（.mcstructure 或存档里保存的结构）：structure.entities[i]、palette.default.block_position_data.<n>.block_entity_data
     */
    function unitsOf(rec) {
        if (rec.kind === 'level') return [];
        if (rec.kind !== 'structure') return rec.tags.map((tg, ri) => tg.t === T.COMPOUND ? { base: [ri], kind: rec.kind === 'player' ? 'actor' : rec.kind } : null).filter(Boolean);
        const units = [];
        rec.tags.forEach((tg, ri) => {
            if (tg.t !== T.COMPOUND) return;
            const st = child(tg.v, 'structure');
            if (!st || st.t !== T.COMPOUND) return;
            const ents = child(st.v, 'entities');
            if (ents && ents.t === T.LIST && ents.v.et === T.COMPOUND) ents.v.items.forEach((_, i) => units.push({ base: [ri, 'structure', 'entities', i], kind: 'actor' }));
            const pal = child(st.v, 'palette');
            const def = pal && pal.t === T.COMPOUND && child(pal.v, 'default');
            const bpd = def && def.t === T.COMPOUND && child(def.v, 'block_position_data');
            if (bpd && bpd.t === T.COMPOUND) {
                for (const e of bpd.v) {
                    const bed = e.t === T.COMPOUND && child(e.v, 'block_entity_data');
                    if (bed && bed.t === T.COMPOUND) units.push({ base: [ri, 'structure', 'palette', 'default', 'block_position_data', e.n, 'block_entity_data'], kind: 'block' });
                }
            }
        });
        return units;
    }

    /** 某个路径所属单元的名称（搜索结果、浏览用） */
    function labelForPath(rec, path) {
        if (rec.kind === 'level') return 'level.dat（世界设置）';
        let best = null;
        for (const u of rec.units || []) {
            if (u.base.length <= path.length && u.base.every((s, i) => s === path[i]) && (!best || u.base.length > best.base.length)) best = u;
        }
        if (best) return unitLabel(rec, nodeAt(rec, best.base).v, best.kind);
        return rec.kind === 'structure' ? `结构 ${rec.name}` : rec.label;
    }

    function rootLabel(rec, ri) {
        if (rec.kind === 'level') return 'level.dat（世界设置）';
        if (rec.kind === 'structure') return `结构 ${rec.name}`;
        if (rec.kind === 'player') return `玩家：${rec.name}`;
        return unitLabel(rec, rec.tags[ri] && rec.tags[ri].v, rec.kind);
    }

    function convertRecords(ctx, records, log) {
        let nBE = 0, nActor = 0, nStruct = 0;
        for (const rec of records) {
            rec.units = unitsOf(rec);
            if (rec.kind === 'structure') nStruct++;
            for (const u of rec.units) {
                u.kind === 'block' ? nBE++ : nActor++;
                if (convertCompound(ctx, rec, u.base, u.kind)) rec.dirty = true;
            }
        }
        const auto = records.filter(r => r.dirty).length;
        log(`扫描方块实体 ${nBE} 个、实体 ${nActor} 个${nStruct ? `（含结构 ${nStruct} 个）` : ''}；自动转换 ${auto} 条记录，提取文本 ${ctx.entries.size} 条，需人工处理 ${ctx.untranslatable.length} 处`);
    }

    /** 编辑会话（存档与结构文件共用）：定位、修改、搜索、导入翻译表、翻译表 */
    function makeSession(records, ctx, opt, extra) {
        const byId = (id) => records[id];
        return {
            records, ctx, opt, ...extra,
            edits: 0,
            /** 解析引用 "记录号|[路径]" */
            resolve(ref) {
                const i = ref.indexOf('|');
                const rec = byId(Number(ref.slice(0, i)));
                if (!rec) return null;
                const path = JSON.parse(ref.slice(i + 1));
                const node = nodeAt(rec, path);
                return node ? { rec, path, node } : null;
            },
            getText(ref) { const r = this.resolve(ref); return r ? displayValue(r.node.t, r.node.v) : null; },
            /** 修改一个值；返回新值显示文本。类型不对抛错 */
            setValue(ref, text) {
                const r = this.resolve(ref);
                if (!r) throw new Error('找不到该位置');
                if (!(r.node.t === T.STRING || NUM_TYPES.has(r.node.t))) throw new Error('该类型不能直接编辑');
                text = String(text);
                if (displayValue(r.node.t, r.node.v) === text) return text;
                const field = bookField(r.path);
                this.notice = '';
                if (field === 'title' && text.length > BOOK_TITLE_MAX) this.notice = `书名超过 ${BOOK_TITLE_MAX} 个字符，游戏里可能显示不全`;
                if (field === 'page' && (text.length > BOOK_PAGE_MAX || text.split('\n').length > BOOK_PAGE_LINES)) {
                    // 超长：自动分页，在当前页之后插入新页
                    const pagesPath = r.path.slice(0, -2);
                    const idx = r.path[r.path.length - 2];
                    const list = nodeAt(r.rec, pagesPath).v;
                    const chunks = splitPages(text);
                    if (list.items.length - 1 + chunks.length > BOOK_MAX_PAGES) throw new Error(`分页后超过 ${BOOK_MAX_PAGES} 页上限，请精简内容`);
                    const template = list.items[idx];
                    const extra = chunks.slice(1).map(c => template.map(e => e.n === 'text' ? { ...e, v: new NBT.NbtString(c, null) } : e));
                    list.items.splice(idx + 1, 0, ...extra);
                    nodeAt(r.rec, r.path).set(new NBT.NbtString(chunks[0], null));
                    // 后面各页的位置都后移了：更新所有引用
                    const prefix = `${r.rec.id}|${JSON.stringify(pagesPath).slice(0, -1)},`;
                    for (const u of this.ctx.untranslatable) {
                        if (!u.ref || !u.ref.startsWith(prefix)) continue;
                        const p = JSON.parse(u.ref.slice(u.ref.indexOf('|') + 1));
                        if (p[pagesPath.length] > idx) { p[pagesPath.length] += extra.length; u.ref = `${r.rec.id}|${JSON.stringify(p)}`; }
                    }
                    // 新页也列入需人工翻译，方便继续修改
                    const at = this.ctx.untranslatable.findIndex(u => u.ref === ref);
                    const base = at >= 0 ? this.ctx.untranslatable[at] : { file: r.rec.label, where: '成书', reason: '成书内容不支持翻译键' };
                    const added = extra.map((_, k) => {
                        const p = [...pagesPath, idx + 1 + k, 'text'];
                        return { file: base.file, where: `成书第 ${idx + 2 + k} 页（自动分页）`, text: chunks[k + 1], reason: base.reason, ref: `${r.rec.id}|${JSON.stringify(p)}` };
                    });
                    this.ctx.untranslatable.splice(at >= 0 ? at + 1 : this.ctx.untranslatable.length, 0, ...added);
                    this.notice = `超过每页 ${BOOK_PAGE_MAX} 字符 / ${BOOK_PAGE_LINES} 行的限制，已自动分成 ${chunks.length} 页`;
                    this.structureChanged = true;
                    r.rec.dirty = true;
                    this.edits++;
                    return chunks[0];
                }
                // 实体改名：记下旧名 → 新名，生成时同步命令里的 @e[name=旧名]
                if (r.path[r.path.length - 1] === 'CustomName' && r.node.t === T.STRING) {
                    const owner = nodeAt(r.rec, r.path.slice(0, -1));
                    if (owner && owner.t === T.COMPOUND && getStr(owner.v, 'identifier')) {
                        if (!this.renames) this.renames = new Map();
                        const old = this.originalNames && this.originalNames.get(ref) != null ? this.originalNames.get(ref) : displayValue(r.node.t, r.node.v);
                        if (!this.originalNames) this.originalNames = new Map();
                        if (!this.originalNames.has(ref)) this.originalNames.set(ref, old);
                        if (text === old) this.renames.delete(old); else this.renames.set(old, text);
                    }
                }
                r.node.set(parseValue(r.node.t, text));
                r.rec.dirty = true;
                this.edits++;
                return displayValue(r.node.t, nodeAt(r.rec, r.path).v);
            },
            /** 该位置的长度限制（编辑器显示计数用） */
            limitOf(ref) {
                const i = ref.indexOf('|');
                const f = bookField(JSON.parse(ref.slice(i + 1)));
                return f === 'page' ? { max: BOOK_PAGE_MAX, lines: BOOK_PAGE_LINES, auto: true } : f === 'title' ? { max: BOOK_TITLE_MAX } : null;
            },
            /** 搜索键名或内容（字符串/数字），返回 [{ ref, rec, pathText, type, value }] */
            search(query, limit = 300) {
                const q = String(query || '').trim().toLowerCase();
                const out = [];
                if (!q) return out;
                for (const rec of records) {
                    const visit = (t, v, path, name) => {
                        if (out.length >= limit) return;
                        if (t === T.COMPOUND) { v.forEach(c => visit(c.t, c.v, [...path, c.n], c.n)); return; }
                        if (t === T.LIST) { v.items.forEach((x, i) => visit(v.et, x, [...path, i], `[${i}]`)); return; }
                        if (t !== T.STRING && !NUM_TYPES.has(t)) return;
                        const val = displayValue(t, v);
                        if (String(name).toLowerCase().includes(q) || val.toLowerCase().includes(q)) {
                            out.push({ ref: `${rec.id}|${JSON.stringify(path)}`, rec, label: labelForPath(rec, path), pathText: pathText(rec, path), type: t, value: val });
                        }
                    };
                    rec.tags.forEach((tg, ri) => visit(tg.t, tg.v, [ri], tg.n));
                    if (out.length >= limit) break;
                }
                return out;
            },
            /** 导入翻译表（untranslatable.csv 填好 translation 列）；返回 { applied, skipped } */
            importCsv(text) {
                const rows = parseCsv(text.replace(/^﻿/, ''));
                const head = rows.shift() || [];
                const iRef = head.indexOf('ref'), iTr = head.indexOf('translation'), iText = head.indexOf('text');
                if (iRef < 0 || iTr < 0) throw new Error('表格缺少 ref 或 translation 列');
                let applied = 0, skipped = 0;
                for (const r of rows) {
                    const tr = r[iTr];
                    if (!r[iRef] || tr == null || tr === '') { skipped++; continue; }
                    // 合并过的行：多个位置用 ; 连接，一起写回
                    for (const ref of String(r[iRef]).split(';').map(x => x.trim()).filter(Boolean)) {
                        const cur = this.getText(ref);
                        if (cur == null) { skipped++; continue; }
                        try { this.setValue(ref, tr); applied++; } catch (e) { skipped++; }
                    }
                    void iText;
                }
                return { applied, skipped };
            },
            hiddenCats: new Set(),   // 编辑器里取消勾选的类别：不显示、不导出
            workbook() { return makeWorkbook(this); },
        };
    }

    // ---------------- 清理存档里的附加包 ----------------
    const EDITOR_TOOL_RE = /world\s*edit|worldedit|\bw\s*edit\b|axiom|structure\s*(tool|wand|builder)|builder'?s?\s*wand|terrain\s*(editor|tool)|map\s*(editor|maker)\s*tool|editor\s*tools?|creative\s*tools?|build\s*tools?/i;
    const verOf = (v) => Array.isArray(v) ? v.map(Number) : (typeof v === 'string' ? v.split(/[.-]/).slice(0, 3).map(Number) : [0, 0, 0]);
    const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
    async function scanWorldPacks(fs, rootDir, packDir) {
        const all = fs.list();
        const packs = [];
        for (const type of ['behavior_packs', 'resource_packs']) {
            const dirs = new Set();
            for (const f of all) {
                if (!f.startsWith(rootDir + type + '/')) continue;
                const rest = f.slice(rootDir.length + type.length + 1);
                if (rest.includes('/')) dirs.add(rest.split('/')[0]);
                else dirs.add('\u0000' + rest);     // 直接放在 behavior_packs/ 下的零散文件
            }
            const regPath = rootDir + (type === 'behavior_packs' ? 'world_behavior_packs.json' : 'world_resource_packs.json');
            let reg = null;   // null：没有登记文件（或读不了）→ 不判断启用与否
            if (all.includes(regPath)) { try { const d = NS.parseJsonLenient(await fs.readText(regPath)); if (Array.isArray(d)) reg = d; } catch (e) { /* 坏的登记文件：不判断 */ } }
            for (const d of dirs) {
                const loose = d.startsWith('\u0000');
                const dir = rootDir + type + '/' + (loose ? '' : d + '/');
                const files = loose ? [rootDir + type + '/' + d.slice(1)] : all.filter(f => f.startsWith(dir));
                const p = { type, dir, folder: loose ? d.slice(1) : d, files, uuid: null, version: [0, 0, 0], name: loose ? d.slice(1) : d, desc: '', deps: [], depList: [], status: null, ours: !loose && dir === packDir };
                const mf = loose ? null : (files.find(f => f === dir + 'manifest.json') || files.filter(f => /\/manifest\.json$/.test(f)).sort((a, b) => a.length - b.length)[0]);   // 多套一层文件夹的也认
                if (!mf) p.status = 'invalid';
                else {
                    let man = null;
                    try { man = NS.parseJsonLenient(await fs.readText(mf)); } catch (e) { man = null; }
                    if (!man || !man.header || !man.header.uuid) p.status = 'invalid';
                    else {
                        p.uuid = String(man.header.uuid).toLowerCase();
                        p.version = verOf(man.header.version);
                        p.name = NS.stripFormatting(String(man.header.name || d));
                        p.desc = NS.stripFormatting(String(man.header.description || ''));
                        p.deps = (man.dependencies || []).map(x => x && x.uuid && String(x.uuid).toLowerCase()).filter(Boolean);
                        p.depList = (man.dependencies || []).filter(x => x && x.uuid).map(x => ({ uuid: String(x.uuid).toLowerCase(), version: verOf(x.version) }));
                    }
                }
                p.noReg = reg == null;
                p.regEntries = p.uuid && reg ? reg.filter(r => r && String(r.pack_id || '').toLowerCase() === p.uuid) : [];
                p.regIndex = p.uuid && reg ? reg.findIndex(r => r && String(r.pack_id || '').toLowerCase() === p.uuid) : -1;
                // 名字 / 描述是 pack.name 这类键时从包里的 lang 取
                if (/^pack\.(name|description)$/.test(p.name) || /^pack\.description$/.test(p.desc)) {
                    const lf = files.find(f => /\/texts\/en_US\.lang$/.test(f)) || files.find(f => /\/texts\/[a-z]{2}_[A-Z]{2}\.lang$/.test(f));
                    if (lf) { try { const L = NS.parseLang(await fs.readText(lf)); if (L.get(p.name)) p.name = NS.stripFormatting(L.get(p.name)); if (L.get(p.desc)) p.desc = NS.stripFormatting(L.get(p.desc)); } catch (e) { /* 忽略 */ } }
                }
                // 本工具上次为行为包新建的翻译资源包（Foo_texts，名字是 pack.name 键或没有 manifest）：不当作无用包
                if (type === 'resource_packs' && !loose && /_texts$/.test(p.folder) && (!mf || /^pack\.name$|- Texts$/.test(p.name))) p.ours = true;
                p.tool = !p.ours && EDITOR_TOOL_RE.test(p.name + ' ' + p.desc + ' ' + p.folder);
                packs.push(p);
            }
        }
        // 已启用：登记了 uuid。同一 uuid 只能加载一份：
        // 行为包保留登记列表里排在最前面的版本（游戏里优先级最高）；资源包优先保留已保留的行为包依赖的那个版本
        const byUuid = new Map();
        for (const p of packs) if (p.uuid) { const k = p.type + '|' + p.uuid; if (!byUuid.has(k)) byUuid.set(k, []); byUuid.get(k).push(p); }
        const kept = new Set();
        const depWant = new Map();   // uuid → [依赖要求的版本]
        const groups = [...byUuid.values()].sort((a, b) => (a[0].type === 'behavior_packs' ? 0 : 1) - (b[0].type === 'behavior_packs' ? 0 : 1));
        for (const list of groups) {
            const valid = list.filter(p => !p.status);
            if (!valid.length) continue;
            const pickOne = (cands) => cands.slice().sort((a, b) => (/\(\d+\)$/.test(a.folder) ? 1 : 0) - (/\(\d+\)$/.test(b.folder) ? 1 : 0))[0];
            let keep = null;
            if (valid[0].noReg) {
                // 没有登记文件：不判断启用与否，同一 uuid 保留版本最高的
                const top = valid.slice().sort((a, b) => cmp(b.version, a.version))[0];
                keep = pickOne(valid.filter(p => cmp(p.version, top.version) === 0));
            } else {
                const regs = valid[0].regEntries;
                if (!regs.length) { for (const p of valid) p.status = p.ours ? 'enabled' : 'unused'; continue; }
                const order = [...(depWant.get(valid[0].uuid) || []), ...regs.map(r => verOf(r.version))];
                for (const v of order) { const c = valid.filter(p => cmp(p.version, v) === 0); if (c.length) { keep = pickOne(c); break; } }
                if (!keep) keep = valid.slice().sort((a, b) => cmp(b.version, a.version))[0];
            }
            for (const p of valid) {
                if (p === keep) {
                    p.status = 'enabled'; kept.add(p);
                    for (const d of p.depList) { if (!depWant.has(d.uuid)) depWant.set(d.uuid, []); depWant.get(d.uuid).push(d.version); }
                } else p.status = 'duplicate';
            }
        }
        // 已启用的包依赖的包（依赖不一定登记）：保留
        const need = [...kept].flatMap(p => p.deps);
        for (let i = 0; i < need.length; i++) {
            for (const p of packs) if (p.uuid === need[i] && p.status === 'unused') { p.status = 'enabled'; p.dependency = true; need.push(...p.deps); }
        }
        // 疑似同一个附加包的不同版本（uuid 不同、都启用，但定义了大部分相同的实体 / 物品 / 方块）：
        // 游戏会同时加载，脚本重复运行；保留登记列表里排最前的（优先级最高）
        {
            const bps = packs.filter(p => p.type === 'behavior_packs' && p.status === 'enabled' && !p.ours && !p.tool && p.regIndex >= 0);
            for (const p of bps) {
                const nested = p.files.filter(f => f !== p.dir + 'manifest.json' && /\/manifest\.json$/.test(f)).map(f => f.replace(/manifest\.json$/, ''));
                p.ids = new Set();
                for (const f of p.files) {
                    if (!/\.json$/i.test(f) || nested.some(n => f.startsWith(n))) continue;
                    let t; try { t = await fs.readText(f); } catch (e) { continue; }
                    const re = /"identifier"\s*:\s*"([^"]+:[^"]+)"/g; let m;
                    while ((m = re.exec(t))) p.ids.add(m[1]);
                }
            }
            const parent = new Map(bps.map(p => [p, p]));
            const find = (p) => { while (parent.get(p) !== p) p = parent.get(p); return p; };
            for (let i = 0; i < bps.length; i++) for (let j = i + 1; j < bps.length; j++) {
                const a = bps[i].ids, b = bps[j].ids;
                if (a.size < 3 || b.size < 3) continue;
                let n = 0; for (const x of a) if (b.has(x)) n++;
                if (n / Math.min(a.size, b.size) >= 0.8) parent.set(find(bps[i]), find(bps[j]));
            }
            const groups = new Map();
            for (const p of bps) { const r = find(p); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); }
            for (const g of groups.values()) {
                if (g.length < 2) continue;
                const keep = g.slice().sort((a, b) => a.regIndex - b.regIndex)[0];
                for (const p of g) if (p !== keep) { p.status = 'same'; p.sameAs = keep; }
            }
            // 被替下来的行为包依赖的资源包：没有别的保留行为包依赖时一起算
            const keptDeps = new Set(packs.filter(p => p.status === 'enabled').flatMap(p => p.deps));
            for (const bp of packs.filter(p => p.status === 'same' && p.type === 'behavior_packs')) {
                for (const d of bp.deps) for (const rp of packs) if (rp.type === 'resource_packs' && rp.uuid === d && rp.status === 'enabled' && !keptDeps.has(d)) { rp.status = 'same'; rp.sameAs = bp.sameAs; }
            }
        }
        return packs;
    }
    async function prunePacks(fs, rootDir, packDir, opt, log) {
        const packs = await scanWorldPacks(fs, rootDir, packDir);
        // 游戏不会加载的包（留在存档里时）：不提取文本
        const skip = () => packs.filter(p => !p.ours && /^(unused|duplicate|invalid)$/.test(p.status) && fs.list().some(f => f.startsWith(p.dir))).map(p => p.dir);
        if (!fs.remove || !packs.length) return skip();
        const size = async (p) => { let n = 0; for (const f of p.files) { try { n += fs.sizeOf ? fs.sizeOf(f) : (await fs.readBytes(f)).length; } catch (e) { /* 忽略 */ } } return n; };
        const mb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
        const why = { unused: '没有启用', duplicate: '同一个包的另一份版本', invalid: '没有有效的 manifest.json' };
        const drop = packs.filter(p => !p.ours && (why[p.status] || (p.tool && opt.removeEditorTools) || (p.status === 'same' && opt.removeSameAddon)));
        const same = packs.filter(p => p.status === 'same' && !opt.removeSameAddon);
        const tools = packs.filter(p => p.tool && p.status === 'enabled' && !opt.removeEditorTools);
        if (!drop.length && !tools.length && !same.length) return skip();
        const label = (p) => p.status === 'same' ? `和 ${p.sameAs.folder} 是同一个附加包的不同版本` : p.tool && !why[p.status] ? '地图编辑工具' : why[p.status];
        const line = async (p) => { const n = await size(p); return [n, `  ${p.type === 'behavior_packs' ? '行为包' : '资源包'} ${p.folder}（${p.name}${p.version.some(Boolean) ? ' v' + p.version.join('.') : ''}，${mb(n)}）：${label(p)}`]; };
        const del = drop.filter(p => opt.prunePacks || p.tool || p.status === 'same');
        const keep = drop.filter(p => !del.includes(p) && why[p.status]);
        if (del.length) {
            let total = 0; const lines = [];
            const unreg = new Map(), unregVer = new Map();
            for (const p of del) {
                const [n, l] = await line(p); total += n; lines.push(l);
                for (const f of p.files) fs.remove(f);
                if (p.uuid && (p.status === 'enabled' || p.status === 'same')) { if (!unreg.has(p.type)) unreg.set(p.type, new Set()); unreg.get(p.type).add(p.uuid); }
            }
            // 删掉的重复版本：登记文件里只留下保留的那个版本
            for (const p of del) if (p.status === 'duplicate' && p.uuid) {
                if (!unregVer.has(p.type)) unregVer.set(p.type, new Map());
                const keepV = packs.find(q => q.type === p.type && q.uuid === p.uuid && q.status === 'enabled');
                if (keepV) unregVer.get(p.type).set(p.uuid, keepV.version);
            }
            for (const [type, m] of unregVer) {
                const regPath = rootDir + (type === 'behavior_packs' ? 'world_behavior_packs.json' : 'world_resource_packs.json');
                try {
                    const d = NS.parseJsonLenient(await fs.readText(regPath));
                    if (!Array.isArray(d)) continue;
                    const seen = new Set();
                    const out = d.filter(r => {
                        const id = r && String(r.pack_id || '').toLowerCase();
                        if (!m.has(id)) return true;
                        if (seen.has(id)) return false;
                        if (r.version && cmp(verOf(r.version), m.get(id)) !== 0) return false;
                        seen.add(id); return true;
                    });
                    for (const [id, v] of m) if (!seen.has(id)) out.push({ pack_id: d.find(r => r && String(r.pack_id || '').toLowerCase() === id)?.pack_id || id, version: v });
                    if (out.length !== d.length) fs.writeText(regPath, JSON.stringify(out, null, 2));
                } catch (e) { /* 没有登记文件 */ }
            }
            // 删掉的已启用包（编辑工具）从 world_*_packs.json 里去掉登记
            for (const [type, set] of unreg) {
                const regPath = rootDir + (type === 'behavior_packs' ? 'world_behavior_packs.json' : 'world_resource_packs.json');
                try {
                    const d = NS.parseJsonLenient(await fs.readText(regPath));
                    if (Array.isArray(d)) fs.writeText(regPath, JSON.stringify(d.filter(r => !(r && set.has(String(r.pack_id || '').toLowerCase()))), null, 2));
                } catch (e) { /* 没有登记文件 */ }
            }
            log(`[存档] 已删除 ${del.length} 个包，省下 ${mb(total)}：\n${lines.join('\n')}`, 'warn');
        }
        if (keep.length) {
            let total = 0; const lines = [];
            for (const p of keep) { const [n, l] = await line(p); total += n; lines.push(l); }
            log(`[存档] 有 ${keep.length} 个包游戏不会加载，共 ${mb(total)}；勾选“删除存档里没启用、重复和无效的包”可以删掉：\n${lines.join('\n')}`, 'warn');
        }
        if (same.length) {
            const lines = [];
            for (const p of same) lines.push((await line(p))[1]);
            log(`[存档] 有 ${same.length} 个包疑似同一个附加包的不同版本（uuid 不同，但定义了大部分相同的实体 / 物品），游戏会同时加载；勾选“同时删除同一附加包的其他版本”只保留登记排最前的：\n${lines.join('\n')}`, 'warn');
        }
        if (tools.length) log(`[存档] 发现地图编辑工具（已启用）：${tools.map(p => `${p.folder}（${p.name}）`).join('、')}；地图做好后通常用不到，勾选“同时删除地图编辑工具”可以删掉并取消启用`, 'warn');
        return skip();
    }

    // ---------------- 打开存档 ----------------
    async function openWorld(fs, userOptions = {}, log = () => {}) {
        const opt = { sourceLang: 'auto', targetLangs: ['en_US', 'zh_CN'], splitNewlines: false, sayMode: 'tellraw', listCommandBlockNames: false, baseName: 'world', prunePacks: false, removeEditorTools: false, removeSameAddon: false, ...userOptions };
        let all = fs.list();
        const levelDat = all.filter(p => /(^|\/)level\.dat$/.test(p)).sort((a, b) => a.length - b.length)[0];
        if (!levelDat) throw new Error('没有找到 level.dat，这不是世界存档');
        const rootDir = levelDat.replace(/level\.dat$/, '');
        // 包文件夹 / 登记文件名大小写不标准（Resource_packs、Behavior_Packs…）：Windows 上游戏照样认，
        // 手机等区分大小写的系统上认不到；统一改成标准写法，否则也会被当成没有资源包而另建一个
        {
            const CANON = ['behavior_packs', 'resource_packs', 'world_behavior_packs.json', 'world_resource_packs.json'];
            const renamed = new Set();
            for (const f of all) {
                if (!f.startsWith(rootDir)) continue;
                const rest = f.slice(rootDir.length);
                const head = rest.split('/')[0];
                const c = CANON.find(x => x.toLowerCase() === head.toLowerCase());
                if (!c || c === head) continue;
                const to = rootDir + c + rest.slice(head.length);
                if (c.endsWith('.json') && all.includes(to)) continue;   // 标准名的登记文件已经有了，保留它
                fs.move(f, to);
                renamed.add(`${head} → ${c}`);
            }
            if (renamed.size) { all = fs.list(); log(`[存档] 文件夹名大小写不标准，已改为标准写法：${[...renamed].join('、')}`, 'warn'); }
        }
        const dbDir = rootDir + 'db/';
        const dbFiles = new Map();
        for (const p of all) if (p.startsWith(dbDir) && !p.slice(dbDir.length).includes('/')) dbFiles.set(p.slice(dbDir.length), await fs.readBytes(p));
        if (!dbFiles.size) throw new Error('存档里没有 db 文件夹');

        let levelName = opt.baseName;
        if (all.includes(rootDir + 'levelname.txt')) levelName = (await fs.readText(rootDir + 'levelname.txt')).trim() || levelName;
        log(`[存档] ${levelName}  db 文件 ${dbFiles.size} 个`);

        const db = await LevelDB.openDb(dbFiles, wantKey);
        log(`[数据库] 有效数据表 ${db.info.tables} 个，当前日志 ${db.info.currentLog || '无'}，最新序列号 ${db.info.lastSeq}`);

        const records = [];
        // level.dat：8 字节头（版本、长度）+ NBT
        const ldBytes = await fs.readBytes(levelDat);
        try {
            const tags = NBT.readAll(ldBytes.subarray(8));
            const rec = { id: 0, kind: 'level', key: null, tags, dirty: false, header: new DataView(ldBytes.buffer, ldBytes.byteOffset).getInt32(0, true) };
            rec.label = rootLabel(rec, 0);
            records.push(rec);
        } catch (e) { log(`[跳过] level.dat 无法解析：${e.message}`, 'warn'); }

        for (const e of db.entries()) {
            let tags;
            try { tags = NBT.readAll(e.value); } catch (err) { log(`[跳过] 无法解析的记录：${err.message}`, 'warn'); continue; }
            if (!tags.length) continue;
            const kind = isStructKey(e.key) ? 'structure' : isPlayerKey(e.key) ? 'player' : isChunkTag(e.key, 49) ? 'block' : 'actor';
            const rec = { id: records.length, kind, key: e.key, tags, dirty: false };
            if (kind === 'structure') rec.name = String.fromCharCode(...e.key.subarray(STRUCT_PREFIX.length)).replace(/^_/, '');
            if (kind === 'player') rec.name = String.fromCharCode(...e.key) === '~local_player' ? '本地玩家' : String.fromCharCode(...e.key);
            rec.label = rootLabel(rec, 0);
            records.push(rec);
        }

        // 之前转换生成的翻译资源包：保留其中的键和译文，新键接在后面，不覆盖
        const packFolder = /^[\x20-\x7e]+$/.test(levelName) ? `${NS.sanitizeKeyPart(levelName)}_texts` : 'world_texts';
        let packDir = `${rootDir}resource_packs/${packFolder}/`;
        // 改过世界名再转换：按名字找不到上次的翻译包时，找含 world.* 键的 *_texts 资源包沿用
        if (!all.some(f => f.startsWith(packDir))) {
            let best = null, bestN = 0;
            const dirs = new Set(all.filter(f => f.startsWith(rootDir + 'resource_packs/')).map(f => f.slice(rootDir.length + 15).split('/')[0]).filter(d => /_texts$/.test(d)));
            for (const d of dirs) {
                let n = 0;
                for (const f of all) {
                    if (!f.startsWith(`${rootDir}resource_packs/${d}/texts/`) || !/\.lang$/.test(f)) continue;
                    try { n += (String(await fs.readText(f)).match(/^world\.[^=\n]+=/mg) || []).length; } catch (e) { /* 忽略 */ }
                }
                if (n > bestN) { best = d; bestN = n; }
            }
            if (best) { packDir = `${rootDir}resource_packs/${best}/`; log(`[资源包] 没有找到 ${packFolder}/，沿用之前生成的 ${best}/（世界名可能改过）`); }
        }
        // ---- 清理存档里的包：没启用的、同一个包的多份旧版本、无效的（没有 manifest）、地图编辑工具 ----
        // 游戏只加载 world_behavior_packs.json / world_resource_packs.json 里登记的包，其余只占空间
        const skipDirs = (await prunePacks(fs, rootDir, packDir, opt, log)) || [];
        all = fs.list();
        // 包文件夹里又套着的包（Foo/Bar_behavior_pack/manifest.json）：游戏不加载，不提取
        for (const f of all) {
            if (!f.startsWith(rootDir)) continue;
            const m = /^((?:behavior_packs|resource_packs)\/[^/]+\/.+\/)manifest\.json$/.exec(f.slice(rootDir.length));
            if (m) skipDirs.push(rootDir + m[1]);
        }
        const skipped = (f) => skipDirs.some(d => f.startsWith(d));
        if (skipDirs.length) log(`[存档] ${skipDirs.length} 个游戏不会加载的包不提取文本`);
        let existingPack = null;
        // 只放回了翻译好的 texts/*.lang（没有 manifest）也算：沿用译文，生成时补上 manifest
        if (all.includes(packDir + 'manifest.json') || all.some(f => f.startsWith(packDir + 'texts/') && /\.lang$/.test(f))) {
            let man = null;
            if (all.includes(packDir + 'manifest.json')) { try { man = NS.parseJsonLenient(await fs.readText(packDir + 'manifest.json')); } catch (e) { man = null; } }
            const langs = new Map();
            for (const f of all) {
                const m = f.startsWith(packDir + 'texts/') && /\/([A-Za-z]{2}_[A-Za-z]{2})\.lang$/.exec(f);
                if (m) { const raw = await fs.readText(f); langs.set(m[1], { path: f, raw, map: NS.parseLang(raw) }); }
            }
            existingPack = { dir: packDir, uuid: man && man.header && man.header.uuid, langs, noManifest: !(man && man.header && man.header.uuid) };
            log(`[资源包] 发现之前生成的 ${packDir}（${langs.size} 种语言），新提取的键会追加进去，已有译文保留`);
        }
        const knownKeys = new Set(), existingValues = new Map();
        // 存档自带资源包 / 行为包里已有的翻译键：文字本身就是这些键时不再提取
        for (const f of all) {
            if (!f.startsWith(rootDir) || f.startsWith(packDir) || !/^(resource_packs|behavior_packs)\/[^/]+\/texts\/[^/]+\.lang$/.test(f.slice(rootDir.length))) continue;
            for (const k of NS.parseLang(await fs.readText(f)).keys()) knownKeys.add(k);
        }
        if (existingPack) for (const [, e] of existingPack.langs) for (const [k, v] of e.map) {
            knownKeys.add(k);
            if (!existingValues.has(k)) existingValues.set(k, new Set());
            existingValues.get(k).add(v);
        }

        // 之前生成的翻译资源包里的键都是本工具生成的：用原始存档再次转换时按顺序认领，已有译文保留
        const keyLangs = new Map(), prevKeys = new Set();
        if (existingPack) for (const [lang, e] of existingPack.langs) for (const k of e.map.keys()) {
            prevKeys.add(k);
            if (!keyLangs.has(k)) keyLangs.set(k, new Set());
            keyLangs.get(k).add(lang);
        }
        const ctx = new NS.ExtractContext({ splitNewlines: opt.splitNewlines, knownKeys, existingValues, keyLangs, prevKeys });
        ctx.sayMode = opt.sayMode;
        ctx.listCommandBlockNames = !!opt.listCommandBlockNames;
        convertRecords(ctx, records, log);

        // ---- 存档自带的行为包 / 资源包（地图常把对话、函数、脚本放在这里）：按附加包流程处理 ----
        let embedded = null;
        const embeddedManifests = all.filter(f => f.startsWith(rootDir) && /^(behavior_packs|resource_packs)\/[^/]+\/manifest\.json$/.test(f.slice(rootDir.length)) && !f.startsWith(packDir) && !skipped(f));
        if (embeddedManifests.length && NS.runPipeline) {
            const sub = {
                list: () => fs.list().filter(f => f.startsWith(rootDir) && /^(behavior_packs|resource_packs)\//.test(f.slice(rootDir.length)) && !f.startsWith(packDir) && !skipped(f)).map(f => f.slice(rootDir.length)),
                readText: (p) => fs.readText(rootDir + p),
                readBytes: (p) => fs.readBytes(rootDir + p),
                writeText: (p, t) => fs.writeText(rootDir + p, t),
                writeBytes: (p, b) => fs.writeBytes(rootDir + p, b),
                move: () => { throw new Error('不支持'); },
            };
            log(`[存档] 发现存档自带的包 ${embeddedManifests.length} 个，按附加包方式提取`);
            try {
                embedded = await NS.runPipeline(sub, {
                    ...NS.DEFAULT_OPTIONS, ...opt, baseName: levelName,
                    newRpRoot: (bp) => `resource_packs/${NS.sanitizeKeyPart(bp.root.split('/').pop())}_texts`,
                }, (m, t) => log('  ' + m, t));
            } catch (e) { log(`[存档] 自带包处理失败：${e.message}`, 'warn'); }
        }

        // 原始 world_resource_packs.json（多次生成时都基于原文件，避免重复登记）
        const wrpPath = rootDir + 'world_resource_packs.json';
        let wrpOriginal = [];
        if (all.includes(wrpPath)) { const d = NS.parseJsonLenient(await fs.readText(wrpPath)); if (Array.isArray(d)) wrpOriginal = d; }
        // 自带行为包没有资源包时新建的翻译资源包：登记到 world_resource_packs.json
        if (embedded && embedded.summary.createdRPs) for (const c of embedded.summary.createdRPs) {
            if (!wrpOriginal.some(p => p && p.pack_id === c.uuid)) wrpOriginal.push({ pack_id: c.uuid, version: [1, 0, 0] });
        }
        if (embedded && embedded.summary.createdRPs && embedded.summary.createdRPs.length) fs.writeText(wrpPath, JSON.stringify(wrpOriginal, null, 2));
        if (embedded) {
            ctx.warnings.push(...embedded.ctx.warnings);
            log(`[存档] 自带包：新增翻译键 ${embedded.summary.newKeys} 条，无法本地化 ${embedded.ctx.untranslatable.length} 处（见翻译表 packs_untranslatable.csv）`);
        }
        // 世界名称（世界列表里显示的名字）：游戏不支持翻译键，放在需人工处理的最前面，可直接改名
        {
            const lr = records.find(r => r.kind === 'level');
            const ln = lr && lr.tags[0] && getStr(lr.tags[0].v, 'LevelName');
            if (ln != null) ctx.untranslatable.unshift({ file: lr.label, where: '世界名称（世界列表里显示的名字）', text: ln, reason: '世界名不支持翻译键，可在这里直接改名', ref: `${lr.id}|${JSON.stringify([0, 'LevelName'])}` });
        }
        const session = makeSession(records, ctx, opt, { levelName, rootDir, levelDatPath: levelDat, wrpOriginal, existingPack, packDir, embedded });
        // 最低可用版本：level.dat 的 MinimumCompatibleClientVersion；存档自带包要求更高时一并说明
        if (NS.MinVersion) {
            const lr = records.find(r => r.kind === 'level');
            const root = lr && lr.tags && lr.tags[0] && lr.tags[0].v;
            const w = root ? NS.MinVersion.estimateWorld(root) : null;
            session.minVersion = NS.MinVersion.mergeWorld(w, embedded && embedded.summary ? embedded.summary.minVersion : null);
            session.packVersions = embedded && embedded.summary ? embedded.summary.packVersions || [] : [];
        }
        session.build = async function (outFs, buildLog = log) { return buildWorld(this, outFs, dbFiles, db, buildLog); };
        return session;
    }

    function pathText(rec, path) {
        return path.slice(1).map(s => typeof s === 'number' ? `[${s}]` : `.${s}`).join('').replace(/^\./, '');
    }

    function parseCsv(text) {
        const rows = [];
        let row = [], cell = '', q = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (q) {
                if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
                else cell += ch;
            } else if (ch === '"') q = true;
            else if (ch === ',') { row.push(cell); cell = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += ch;
        }
        if (cell || row.length) { row.push(cell); rows.push(row); }
        return rows.filter(r => r.some(c => c !== ''));
    }

    function csvText(rows) {
        return '﻿' + rows.map(r => r.map(x => { const t = String(x == null ? '' : x); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
    }

    function detectLang(session) {
        const values = [...session.ctx.entries.values()].map(e => e.value);
        return session.opt.sourceLang === 'auto' ? NS.detectSourceLang(values) : session.opt.sourceLang;
    }

    /** 待翻译条目的类别（编辑器筛选与导出共用） */
    const categoryOf = (u) => u.where.startsWith('/') ? '命令' : /成书|讲台书/.test(u.where) ? '成书' : u.where.replace(/（.*$/, '');

    function makeWorkbook(session) {
        const { ctx } = session;
        const hidden = session.hiddenCats || new Set();
        const sourceLang = detectLang(session);
        return {
            'strings.csv': csvText([['key', 'source_text', 'location', 'type'], ...[...ctx.entries].map(([k, e]) => [k, e.value, e.file, e.kind])]),
            // 填写 translation 列后可在网页里“导入翻译表”批量写回
            // 原文、原因、类别都相同的合并成一行（ref 用 ; 连接，导入时一起写回）；成书页面各自一行
            'untranslatable.csv': csvText([['ref', 'location', 'where', 'text', 'reason', 'count', 'translation'], ...(() => {
                const groups = new Map(), out = [];
                for (const u of ctx.untranslatable) {
                    if (hidden.has(categoryOf(u))) continue;
                    const page = u.ref && bookField(JSON.parse(u.ref.slice(u.ref.indexOf('|') + 1))) === 'page';
                    const key = page || !u.ref ? '\u0001' + out.length : `${u.text}\u0000${u.reason}\u0000${categoryOf(u)}`;
                    let g = groups.get(key);
                    if (!g) { g = { u, refs: [], files: [] }; groups.set(key, g); out.push(g); }
                    if (u.ref) g.refs.push(u.ref);
                    if (!g.files.includes(u.file)) g.files.push(u.file);
                }
                return out.map(g => [g.refs.join(';'), g.files.length > 1 ? `${g.files[0]} 等 ${g.files.length} 处` : g.files[0], g.u.where, g.u.text, g.u.reason, g.refs.length || 1, '']);
            })()]),
            [`source_${sourceLang}.lang`]: [...ctx.entries].map(([k, e]) => `${k}=${NS.toLangValue(e.value)}`).join('\n') + '\n',
            // 存档自带的行为包 / 资源包
            ...(session.embedded ? Object.fromEntries(Object.entries(session.embedded.workbook).map(([n, c]) => [`packs_${n}`, c])) : {}),
        };
    }

    async function buildWorld(session, fs, dbFiles, db, log) {
        const { ctx, records, rootDir, levelName, opt } = session;
        const dbDir = rootDir + 'db/';

        // ---- 实体改了名：命令里 @e[name=旧名] 同步改成新名（命令方块、NPC 按钮、自带包的函数 / 动画控制器 / 脚本） ----
        if (session.renames && session.renames.size) {
            let n = 0;
            const walkStr = (rec, t, v, setter) => {
                if (t === T.STRING) { const r = NS.renameSelectorNames(displayValue(T.STRING, v), session.renames); if (r.n) { setter(new NBT.NbtString(r.text, null)); n += r.n; rec.dirty = true; } return; }
                if (t === T.COMPOUND) { for (const c of v) walkStr(rec, c.t, c.v, (x) => { c.v = x; }); return; }
                if (t === T.LIST) v.items.forEach((x, i) => walkStr(rec, v.et, x, (y) => { v.items[i] = y; }));
            };
            for (const rec of records) rec.tags.forEach(tg => walkStr(rec, tg.t, tg.v, (x) => { tg.v = x; }));
            for (const f of fs.list()) {
                if (!f.startsWith(rootDir + 'behavior_packs/') || !/\.(mcfunction|json|js)$/i.test(f)) continue;
                let t; try { t = await fs.readText(f); } catch (e) { continue; }
                const r = NS.renameSelectorNames(t, session.renames);
                if (r.n) { fs.writeText(f, r.text); n += r.n; }
            }
            if (n) log(`[实体名] 改了 ${session.renames.size} 个实体的名字，命令里的 name= 选择器同步修改 ${n} 处`);
        }

        // ---- 数据库 ----
        const puts = records.filter(r => r.dirty && r.kind !== 'level').map(r => ({ key: r.key, value: NBT.writeAll(r.tags) }));
        if (puts.length) {
            const r = LevelDB.appendPuts(dbFiles, db, puts);
            const check = new Map(dbFiles); check.set(r.name, r.bytes);
            const db2 = await LevelDB.openDb(check, wantKey);
            const bad = puts.filter(pu => { const v = db2.get(pu.key); return !v || v.length !== pu.value.length || v.some((x, i) => x !== pu.value[i]); });
            if (bad.length) throw new Error(`写回自检失败（${bad.length} 条），已中止，未生成文件`);
            fs.writeBytes(dbDir + r.name, r.bytes);
            log(`[写回] 追加到 db/${r.name}，已重新读取校验 ${puts.length} 条`);
        }

        // ---- level.dat ----
        const lv = records.find(r => r.kind === 'level');
        if (lv && lv.dirty) {
            const body = NBT.writeAll(lv.tags);
            const out = new Uint8Array(8 + body.length);
            const dv = new DataView(out.buffer);
            dv.setInt32(0, lv.header, true);
            dv.setInt32(4, body.length, true);
            out.set(body, 8);
            fs.writeBytes(session.levelDatPath, out);
            // 世界列表显示的名字来自 levelname.txt
            const ln = getStr(lv.tags[0].v, 'LevelName');
            if (ln != null) fs.writeText(rootDir + 'levelname.txt', ln);
            log('[写回] level.dat 已更新');
        }

        // ---- 资源包 ----
        const sourceLang = detectLang(session);
        let packDir = null;
        const ex = session.existingPack;
        if (ctx.entries.size && ex) {
            // 追加到之前生成的资源包：已有内容（含译文）原样保留
            packDir = ex.dir;
            const langs = [...new Set([...ex.langs.keys(), ...opt.targetLangs, sourceLang, 'en_US'])];
            let added = 0;
            for (const l of langs) {
                const e = ex.langs.get(l);
                // 这个语言文件里已有的键（含译文）不再追加，避免后写的原文覆盖译文
                const rows = [...ctx.entries].filter(([k]) => !(e && e.map.has(k))).map(([k, en]) => `${k}=${NS.toLangValue(en.value)}`);
                added = Math.max(added, rows.length);
                const head = e ? e.raw.replace(/\s*$/, '\n') : `pack.name=${levelName} - Texts\npack.description=Translations for ${levelName}\n`;
                if (e && !rows.length) continue;
                fs.writeText(e ? e.path : `${packDir}texts/${l}.lang`, rows.length ? `${head}\n## ==== addon-i18n 再次提取新增（源语言 ${sourceLang}${l === sourceLang ? '' : '，待翻译'}） ====\n${rows.join('\n')}\n` : head);
            }
            fs.writeText(`${packDir}texts/languages.json`, JSON.stringify(langs, null, 2));
            if (ex.noManifest) {
                const pk = textsPackFiles(ctx, opt, levelName, sourceLang);
                fs.writeText(packDir + 'manifest.json', pk.files.get('manifest.json'));
                ex.uuid = pk.uuid; ex.noManifest = false;
            }
            const wrp = rootDir + 'world_resource_packs.json';
            if (ex.uuid && !session.wrpOriginal.some(p => p && p.pack_id === ex.uuid)) fs.writeText(wrp, JSON.stringify([...session.wrpOriginal, { pack_id: ex.uuid, version: [1, 0, 0] }], null, 2));
            log(`[资源包] 追加 ${added} 个新键到 ${packDir}（已有内容保留）`);
        } else if (ctx.entries.size) {
            packDir = session.packDir;
            const pack = textsPackFiles(ctx, opt, levelName, sourceLang);
            for (const [p, text] of pack.files) fs.writeText(packDir + p, text);
            const wrp = rootDir + 'world_resource_packs.json';
            fs.writeText(wrp, JSON.stringify([...session.wrpOriginal, { pack_id: pack.uuid, version: [1, 0, 0] }], null, 2));
            log(`[资源包] 新建 ${packDir}，语言 ${pack.langs.join(', ')}，已登记到 world_resource_packs.json`);
        }

        return {
            get workbook() { return makeWorkbook(session); },
            summary: {
                packs: [], processedFiles: records.filter(r => r.dirty).length, newKeys: ctx.entries.size, packKeys: 0, placeholders: 0,
                untranslatable: ctx.untranslatable.length, warnings: ctx.warnings, missingRefs: [], sourceLang,
                createdRP: packDir, restructured: false, inputGroups: 0, world: true, manualEdits: session.edits,
                minVersion: session.minVersion || null, packVersions: session.packVersions || [],
            },
        };
    }


    // ---------------- 结构文件 .mcstructure ----------------
    // 格式：小端 NBT（无文件头），structure.entities 为实体，
    //       structure.palette.default.block_position_data.<序号>.block_entity_data 为方块实体

    /** 生成存放翻译的资源包文件：返回 Map(相对路径 → 文本) 和 uuid */
    function textsPackFiles(ctx, opt, title, sourceLang) {
        const uuid = () => (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
            : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => { const r = Math.random() * 16 | 0; return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
        const packUuid = uuid();
        const files = new Map();
        files.set('manifest.json', JSON.stringify({
            format_version: 2,
            header: { name: 'pack.name', description: 'pack.description', uuid: packUuid, version: [1, 0, 0], min_engine_version: [1, 20, 0] },
            modules: [{ type: 'resources', uuid: uuid(), version: [1, 0, 0] }],
        }, null, 2));
        const langs = [...new Set([...opt.targetLangs, sourceLang, 'en_US'])];
        const body = [...ctx.entries].map(([k, e]) => `${k}=${NS.toLangValue(e.value)}`).join('\n');
        for (const l of langs) {
            files.set(`texts/${l}.lang`, `pack.name=${title} - Texts\npack.description=Translations for ${title}\n\n## ==== addon-i18n 自动提取（源语言 ${sourceLang}${l === sourceLang ? '' : '，待翻译'}） ====\n${body}\n`);
        }
        files.set('texts/languages.json', JSON.stringify(langs, null, 2));
        return { files, uuid: packUuid, langs };
    }

    function structureRecord(name, bytes) {
        const tags = NBT.readAll(bytes);
        if (!tags.length || tags[0].t !== T.COMPOUND || !child(tags[0].v, 'structure')) throw new Error('不是有效的 .mcstructure 文件');
        const rec = { id: 0, kind: 'structure', key: null, tags, dirty: false, name };
        rec.label = rootLabel(rec, 0);
        return rec;
    }

    /** 单独的结构文件：打开为可编辑会话 */
    async function openStructure(fileName, bytes, userOptions = {}, log = () => {}) {
        const opt = { sourceLang: 'auto', targetLangs: ['en_US', 'zh_CN'], splitNewlines: false, sayMode: 'tellraw', listCommandBlockNames: false, ...userOptions };
        const name = fileName.replace(/^.*\//, '').replace(/\.mcstructure$/i, '');
        const rec = structureRecord(name, bytes);
        const size = child(rec.tags[0].v, 'size');
        log(`[结构] ${name}  尺寸 ${size && size.t === T.LIST ? size.v.items.join('×') : '?'}`);
        const records = [rec];
        const ctx = new NS.ExtractContext({ splitNewlines: opt.splitNewlines });
        ctx.sayMode = opt.sayMode;
        ctx.listCommandBlockNames = !!opt.listCommandBlockNames;
        convertRecords(ctx, records, log);
        const session = makeSession(records, ctx, opt, { structureName: name, levelName: name });
        /** 返回 { structure: Uint8Array, pack: Map(路径→文本) | null, workbook, summary } */
        session.build = async function () {
            const sourceLang = detectLang(this);
            const pack = ctx.entries.size ? textsPackFiles(ctx, opt, name, sourceLang).files : null;
            return {
                structure: NBT.writeAll(rec.tags), pack,
                workbook: makeWorkbook(this),
                summary: { world: true, structure: true, newKeys: ctx.entries.size, untranslatable: ctx.untranslatable.length, sourceLang, manualEdits: this.edits },
            };
        };
        return session;
    }

    /**
     * 附加包里的结构文件：用附加包的上下文提取（翻译写进附加包的资源包）
     * @returns { bytes, changed }
     */
    function convertStructureBytes(bytes, file, ctx) {
        const rec = structureRecord(file.replace(/^.*\//, '').replace(/\.mcstructure$/i, ''), bytes);
        // 记下来，转换完后可在编辑器里手动修改 / 用翻译表导入（ref = 记录号|路径）
        if (!ctx.structureRecords) ctx.structureRecords = [];
        rec.id = ctx.structureRecords.length;
        rec.file = file;
        ctx.structureRecords.push(rec);
        rec.units = unitsOf(rec);
        let changed = false;
        for (const u of rec.units) if (convertCompound(ctx, rec, u.base, u.kind)) changed = true;
        rec.dirty = false;   // 自动转换已由流水线写出；之后的手动修改才算 dirty
        return { bytes: changed ? NBT.writeAll(rec.tags) : bytes, changed, units: rec.units.length };
    }

    /**
     * 附加包里的结构文件：转换后的编辑会话（需人工翻译只含结构里的条目）
     * session.applyTo(fs) 把手动修改过的结构写回附加包
     */
    function makeAddonStructureSession(ctx, opt = {}) {
        const records = ctx.structureRecords || [];
        if (!records.length) return null;
        const sub = Object.create(ctx);
        sub.untranslatable = ctx.untranslatable.filter(u => u.ref);
        if (!sub.untranslatable.length) return null;
        const session = makeSession(records, sub, opt, { structureName: '附加包内的结构', levelName: '附加包内的结构', addonStructures: true });
        session.applyTo = function (fs) {
            let n = 0;
            for (const rec of records) if (rec.dirty) { fs.writeBytes(rec.file, NBT.writeAll(rec.tags)); n++; }
            return n;
        };
        return session;
    }

    /** 一步完成（测试与非交互使用） */
    async function runWorldPipeline(fs, userOptions = {}, log = () => {}) {
        const session = await openWorld(fs, userOptions, log);
        const r = await session.build(fs, log);
        return { ctx: session.ctx, session, ...r };
    }

    NS.openWorld = openWorld;
    NS.openStructure = openStructure;
    NS.convertStructureBytes = convertStructureBytes;
    NS.makeAddonStructureSession = makeAddonStructureSession;
    NS.runWorldPipeline = runWorldPipeline;
    NS.worldNodeAt = nodeAt;
    NS.worldCategoryOf = categoryOf;
    NS.worldRootLabel = rootLabel;
    NS.worldDisplayValue = displayValue;
    NS.worldParseCsv = parseCsv;
    NS.worldSplitPages = splitPages;
})(typeof globalThis !== 'undefined' ? globalThis : this);
