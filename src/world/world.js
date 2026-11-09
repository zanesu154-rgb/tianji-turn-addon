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
                const name = getStr(it, 'Name') || '';
                const tag = child(it, 'tag');
                if (!tag || tag.t !== T.COMPOUND) return;
                const slot = child(it, 'Slot');
                const kb = `${keyBase}.s${slot ? slot.v : i}`;
                const display = child(tag.v, 'display');
                if (display && display.t === T.COMPOUND) {
                    const dn = getStr(display.v, 'Name');
                    if (dn) report([...path, i, 'tag', 'display', 'Name'], `物品名（${name}）`, dn, '物品自定义名称不支持翻译键');
                    const lore = child(display.v, 'Lore');
                    if (lore && lore.t === T.LIST && lore.v.et === T.STRING) lore.v.items.forEach((l, j) => l.s && report([...path, i, 'tag', 'display', 'Lore', j], `物品描述（${name}）`, l.s, '物品描述不支持翻译键'));
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
            });
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
            if (id === 'CommandBlock') cmd(P('Command'), `${kp}.command.${pos}`, { text: getStr(c, 'CustomName') || '@' });
            const cn = getStr(c, 'CustomName');
            if (cn && id === 'CommandBlock') { if (ctx.listCommandBlockNames) report(P('CustomName'), '命令方块名称', cn, '命令方块名称（say 等命令输出时显示的发送者名）不支持翻译键'); }
            else if (cn) report(P('CustomName'), '方块名称', cn, '容器/方块的自定义名称不支持翻译键');
            items(P('Items'), `${kp}.book.${pos}`);
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
            if (ident === 'minecraft:npc') {
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
            if (cn && ident !== 'minecraft:npc' && (ident !== 'minecraft:command_block_minecart' || ctx.listCommandBlockNames)) report(P('CustomName'), ident === 'minecraft:command_block_minecart' ? '命令方块名称' : '实体名字标签', cn, '实体名称只能是纯文本，不支持翻译键');
            const who = rec.kind === 'player' ? 'player' : idPart;
            for (const f of ['Armor', 'Mainhand', 'Offhand', 'ChestItems', 'Items', 'Inventory', 'EnderChestInventory', 'PlayerUIItems']) items(P(f), `${kp}.book.${who}.${f.toLowerCase()}`);
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
                    const ref = r[iRef], tr = r[iTr];
                    if (!ref || tr == null || tr === '') { skipped++; continue; }
                    const cur = this.getText(ref);
                    if (cur == null) { skipped++; continue; }
                    // 原文已被改动过（与表中不一致）时仍以表为准，但记录下来
                    try { this.setValue(ref, tr); applied++; } catch (e) { skipped++; }
                    void iText;
                }
                return { applied, skipped };
            },
            hiddenCats: new Set(),   // 编辑器里取消勾选的类别：不显示、不导出
            workbook() { return makeWorkbook(this); },
        };
    }

    // ---------------- 打开存档 ----------------
    async function openWorld(fs, userOptions = {}, log = () => {}) {
        const opt = { sourceLang: 'auto', targetLangs: ['en_US', 'zh_CN'], splitNewlines: false, sayMode: 'tellraw', listCommandBlockNames: false, baseName: 'world', ...userOptions };
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

        const ctx = new NS.ExtractContext({ splitNewlines: opt.splitNewlines });
        ctx.sayMode = opt.sayMode;
        ctx.listCommandBlockNames = !!opt.listCommandBlockNames;
        convertRecords(ctx, records, log);

        // 原始 world_resource_packs.json（多次生成时都基于原文件，避免重复登记）
        const wrpPath = rootDir + 'world_resource_packs.json';
        let wrpOriginal = [];
        if (all.includes(wrpPath)) { const d = NS.parseJsonLenient(await fs.readText(wrpPath)); if (Array.isArray(d)) wrpOriginal = d; }
        const session = makeSession(records, ctx, opt, { levelName, rootDir, levelDatPath: levelDat, wrpOriginal });
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
            'untranslatable.csv': csvText([['ref', 'location', 'where', 'text', 'reason', 'translation'],
                ...ctx.untranslatable.filter(u => !hidden.has(categoryOf(u))).map(u => [u.ref || '', u.file, u.where, u.text, u.reason, ''])]),
            [`source_${sourceLang}.lang`]: [...ctx.entries].map(([k, e]) => `${k}=${NS.toLangValue(e.value)}`).join('\n') + '\n',
        };
    }

    async function buildWorld(session, fs, dbFiles, db, log) {
        const { ctx, records, rootDir, levelName, opt } = session;
        const dbDir = rootDir + 'db/';

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
            if (ln != null && fs.list().includes(rootDir + 'levelname.txt')) fs.writeText(rootDir + 'levelname.txt', ln);
            log('[写回] level.dat 已更新');
        }

        // ---- 资源包 ----
        const sourceLang = detectLang(session);
        let packDir = null;
        if (ctx.entries.size) {
            const folder = /^[\x20-\x7e]+$/.test(levelName) ? `${NS.sanitizeKeyPart(levelName)}_texts` : 'world_texts';
            packDir = `${rootDir}resource_packs/${folder}/`;
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
        rec.units = unitsOf(rec);
        let changed = false;
        for (const u of rec.units) if (convertCompound(ctx, rec, u.base, u.kind)) changed = true;
        return { bytes: changed ? NBT.writeAll(rec.tags) : bytes, changed, units: rec.units.length };
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
    NS.runWorldPipeline = runWorldPipeline;
    NS.worldNodeAt = nodeAt;
    NS.worldCategoryOf = categoryOf;
    NS.worldRootLabel = rootLabel;
    NS.worldDisplayValue = displayValue;
    NS.worldParseCsv = parseCsv;
    NS.worldSplitPages = splitPages;
})(typeof globalThis !== 'undefined' ? globalThis : this);
