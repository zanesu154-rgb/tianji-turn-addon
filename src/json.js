/* ================================================================
 *  json.js —— 各类 JSON 文件的处理器
 *  每个处理器原地修改 data，返回是否有改动
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;
    const { looksLikeText, isEmptyText, sanitizeKeyPart, fileBaseOf, translateCommand } = NS;

    // ---------------------------------------------------------------
    //  通用字段替换
    // ---------------------------------------------------------------

    /**
     * 只接受“纯键名字符串”的字段（物品名、方块名、交互文字、交易界面名、UI 文本……）
     * 支持 "xxx" 和 {"value":"xxx"} 两种写法
     */
    /** 不提取、不补全的键（创造栏隐藏的物品 / 方块、不显示的刷怪蛋） */
    function hideKeys(ctx, keys) {
        if (!ctx.hiddenKeys) ctx.hiddenKeys = new Set();
        for (const k of keys) if (k) ctx.hiddenKeys.add(k);
    }
    /** 字段里已经是翻译键时返回这个键 */
    function keyOfField(container, field) {
        const v = container && container[field];
        const t = typeof v === 'string' ? v : (v && typeof v.value === 'string' ? v.value : '');
        return t && /^[\w.:\-]+$/.test(t.trim()) && /[.:]/.test(t) ? t.trim() : '';
    }

    function replaceKeyField(container, field, baseKey, ctx, meta) {
        if (!container || typeof container !== 'object') return false;
        const v = container[field];
        let text, set;
        if (typeof v === 'string') { text = v; set = k => { container[field] = k; }; }
        else if (v && typeof v === 'object' && typeof v.value === 'string') { text = v.value; set = k => { v.value = k; }; }
        else return false;
        if (isEmptyText(text)) return false;
        if (ctx.isKey(text)) { ctx.ref(text.trim(), meta.file); return false; }
        if (!looksLikeText(text, 'loose')) return false;
        if (/[\r\n]/.test(text)) ctx.warn(`${meta.file}: "${field}" 含换行，已写成 \\n`);
        set(ctx.alloc(baseKey, text, meta));
        return true;
    }

    /** 支持 rawtext 的字段（NPC 对话的名字 / 正文 / 按钮） */
    function replaceRawtextField(container, field, baseKey, ctx, meta) {
        if (!container || typeof container !== 'object') return false;
        const v = container[field];
        if (typeof v === 'string') {
            if (isEmptyText(v)) return false;
            if (ctx.isKey(v)) {
                // 纯字符串写键名不会被翻译，改成 rawtext.translate
                container[field] = { rawtext: [{ translate: v.trim() }] };
                ctx.ref(v.trim(), meta.file);
                return true;
            }
            const parts = ctx.rawParts(v, baseKey, meta);
            if (!parts) return false;
            container[field] = { rawtext: parts };
            return true;
        }
        if (v && typeof v === 'object' && Array.isArray(v.rawtext)) {
            return ctx.processRawMessage(v, baseKey, meta);
        }
        return false;
    }

    /** 处理 "command" 字段（字符串或数组），用于实体/物品/方块事件 */
    function scanCommandFields(obj, baseKey, ctx, file) {
        let changed = false;
        (function walk(node) {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (!node || typeof node !== 'object') return;
            for (const [k, v] of Object.entries(node)) {
                if (k === 'command' || k === 'commands') {
                    if (typeof v === 'string') {
                        const r = translateCommand(v, ctx, baseKey, file);
                        if (r.changed) { node[k] = r.cmd; changed = true; }
                    } else if (Array.isArray(v)) {
                        v.forEach((c, i) => {
                            if (typeof c !== 'string') return;
                            const r = translateCommand(c, ctx, baseKey, file);
                            if (r.changed) { v[i] = r.cmd; changed = true; }
                        });
                    }
                } else {
                    walk(v);
                }
            }
        })(obj);
        return changed;
    }

    // ---------------------------------------------------------------
    //  物品
    // ---------------------------------------------------------------

    function processItem(data, file, ctx, info) {
        const item = data['minecraft:item'];
        if (!item || typeof item !== 'object') return false;
        const id = item.description && item.description.identifier;
        if (!id) return false;
        const comps = item.components || {};
        const meta = { file, kind: 'item' };
        let changed = false;
        const hidden = isHiddenFromCreative(item.description);
        // 创造物品栏里不显示的物品（技术物品、进度图标等）：默认不提取名称，已有键也不补全
        const skipName = hidden && !ctx.includeHiddenItems;
        if (skipName) hideKeys(ctx, [`item.${id}.name`, `item.${id}`, `tile.${id}.name`, keyOfField(comps, 'minecraft:display_name')]);

        if (!skipName && replaceKeyField(comps, 'minecraft:display_name', `item.${id}.name`, ctx, meta)) changed = true;
        const ib = comps['minecraft:interact_button'];
        if (typeof ib === 'string' && ib !== 'true' && ib !== 'false') {
            if (replaceKeyField(comps, 'minecraft:interact_button', `item.${id}.interact_button`, ctx, meta)) changed = true;
        }
        if (scanCommandFields(item.events, `item.${id}.message`, ctx, file)) changed = true;

        const placer = comps['minecraft:block_placer'];
        const placesBlock = placer && typeof placer === 'object' && placer.replace_block_item && typeof placer.block === 'string' ? placer.block : (placer && typeof placer.block === 'object' && placer.replace_block_item && placer.block.name) || null;
        info.defs.items.push({ id, file, data, hasName: comps['minecraft:display_name'] != null, isDataDriven: !!item.components, hidden, placesBlock });
        return changed;
    }

    // ---------------------------------------------------------------
    //  方块
    // ---------------------------------------------------------------

    function processBlock(data, file, ctx, info) {
        const block = data['minecraft:block'];
        if (!block || typeof block !== 'object') return false;
        const id = block.description && block.description.identifier;
        if (!id) return false;
        const meta = { file, kind: 'block' };
        let changed = false;
        const base = `tile.${id}.name`;

        const hidden = isHiddenFromCreative(block.description);
        // 有可见物品代替它出现在创造栏（同 ID，或 block_placer + replace_block_item）：名称照常处理
        const skipName = hidden && !ctx.includeHiddenItems && !(ctx.visibleItemBlocks && ctx.visibleItemBlocks.has(id));
        if (skipName) hideKeys(ctx, [base, `item.${id}.name`, `item.${id}`]);
        const handleComps = (comps, suffix) => {
            if (!comps || typeof comps !== 'object') return;
            if (skipName) hideKeys(ctx, [base + suffix, keyOfField(comps, 'minecraft:display_name')]);
            else if (replaceKeyField(comps, 'minecraft:display_name', base + suffix, ctx, meta)) changed = true;
            const ct = comps['minecraft:crafting_table'];
            if (ct && typeof ct === 'object') {
                if (replaceKeyField(ct, 'table_name', `tile.${id}.table_name${suffix}`, ctx, meta)) changed = true;
            }
        };
        handleComps(block.components, '');
        if (Array.isArray(block.permutations)) {
            block.permutations.forEach((p, i) => p && handleComps(p.components, `.perm_${i}`));
        }
        if (scanCommandFields(block.events, `tile.${id}.message`, ctx, file)) changed = true;

        const hasName = !!(block.components && block.components['minecraft:display_name']);
        info.defs.blocks.push({ id, file, hasName, hidden });
        return changed;
    }

    // ---------------------------------------------------------------
    //  实体
    // ---------------------------------------------------------------

    function processEntity(data, file, ctx, info) {
        const entity = data['minecraft:entity'];
        if (!entity || typeof entity !== 'object') return false;
        const id = entity.description && entity.description.identifier;
        if (!id) return false;
        const meta = { file, kind: 'entity' };
        let changed = false;
        let interactN = 0;

        const handleComps = (comps, where) => {
            if (!comps || typeof comps !== 'object') return;

            // minecraft:interact —— 旧格式是数组，新格式是 { interactions: [...] } 或单个对象
            const interact = comps['minecraft:interact'];
            let list = [];
            if (Array.isArray(interact)) list = interact;
            else if (interact && Array.isArray(interact.interactions)) list = interact.interactions;
            else if (interact && typeof interact === 'object') list = [interact];
            for (const it of list) {
                if (it && typeof it === 'object' && 'interact_text' in it) {
                    if (replaceKeyField(it, 'interact_text', `action.interact.${id}.${interactN++}`, ctx, { ...meta, scope: 'interact:' + id })) changed = true;
                }
            }

            for (const tt of ['minecraft:trade_table', 'minecraft:economy_trade_table']) {
                if (comps[tt] && typeof comps[tt] === 'object') {
                    if (replaceKeyField(comps[tt], 'display_name', `entity.${id}.trade_name`, ctx, { ...meta, scope: 'trade:' + id })) changed = true;
                }
            }

            // minecraft:boss.name：游戏内实测支持翻译键（血条显示 lang 中的值）
            if (comps['minecraft:boss'] && typeof comps['minecraft:boss'] === 'object') {
                if (replaceKeyField(comps['minecraft:boss'], 'name', `entity.${id}.boss_name`, ctx, { ...meta, scope: 'boss:' + id })) changed = true;
            }
        };

        handleComps(entity.components, 'components');
        for (const [g, comps] of Object.entries(entity.component_groups || {})) handleComps(comps, `component_groups.${g}`);
        if (scanCommandFields(entity, `entity.${id}.message`, ctx, file)) changed = true;

        // 刷怪蛋只有 is_spawnable 为 true 时才出现在创造物品栏
        const spawnable = entity.description.is_spawnable === true;
        if (!spawnable && !ctx.includeHiddenItems) hideKeys(ctx, [`item.spawn_egg.entity.${id}.name`]);
        info.defs.entities.push({ id, file, spawnable });
        return changed;
    }

    // ---------------------------------------------------------------
    //  NPC 对话
    // ---------------------------------------------------------------

    function processDialogue(data, file, ctx) {
        const dlg = data['minecraft:npc_dialogue'];
        if (!dlg || !Array.isArray(dlg.scenes)) return false;
        let changed = false;
        const fileBase = fileBaseOf(file);

        const doCommands = (arr, baseKey) => {
            if (!Array.isArray(arr)) return;
            arr.forEach((c, i) => {
                if (typeof c !== 'string') return;
                const r = translateCommand(c, ctx, baseKey, file);
                if (r.changed) { arr[i] = r.cmd; changed = true; }
            });
        };

        for (const scene of dlg.scenes) {
            if (!scene || typeof scene !== 'object') continue;
            const tag = sanitizeKeyPart(scene.scene_tag || fileBase);
            const base = `dialogue.${tag}`;
            const meta = { file, kind: 'dialogue', scope: 'dialogue' };
            if (replaceRawtextField(scene, 'npc_name', `${base}.npc_name`, ctx, meta)) changed = true;
            if (replaceRawtextField(scene, 'text', `${base}.text`, ctx, meta)) changed = true;
            (scene.buttons || []).forEach((btn, i) => {
                if (!btn || typeof btn !== 'object') return;
                if (replaceRawtextField(btn, 'name', `${base}.button_${i}`, ctx, meta)) changed = true;
                doCommands(btn.commands, `${base}.message`);
            });
            doCommands(scene.on_open_commands, `${base}.message`);
            doCommands(scene.on_close_commands, `${base}.message`);
        }
        return changed;
    }

    // ---------------------------------------------------------------
    //  行为包动画 / 动画控制器 —— 只处理以 / 开头的命令字符串
    // ---------------------------------------------------------------

    function processAnimationCommands(data, file, ctx, kindPrefix) {
        let changed = false;
        const base = `${kindPrefix}.${fileBaseOf(file)}.message`;
        (function walk(node) {
            if (Array.isArray(node)) {
                node.forEach((v, i) => {
                    if (typeof v === 'string') {
                        if (!v.trim().startsWith('/')) return;
                        const r = translateCommand(v, ctx, base, file);
                        if (r.changed) { node[i] = r.cmd; changed = true; }
                    } else walk(v);
                });
                return;
            }
            if (!node || typeof node !== 'object') return;
            for (const [k, v] of Object.entries(node)) {
                if (typeof v === 'string') {
                    if (!v.trim().startsWith('/')) continue;
                    const r = translateCommand(v, ctx, base, file);
                    if (r.changed) { node[k] = r.cmd; changed = true; }
                } else walk(v);
            }
        })(data);
        return changed;
    }

    // ---------------------------------------------------------------
    //  战利品表 / 交易表 —— set_name / set_lore 设置的是“自定义名称”，
    //  游戏不会对其做本地化，替换成键会直接显示键名，所以只记录
    // ---------------------------------------------------------------

    function reportLootNames(data, file, ctx) {
        (function walk(node) {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (!node || typeof node !== 'object') return;
            if (node.function === 'set_name' && typeof node.name === 'string') {
                ctx.report(file, 'set_name', node.name, '物品自定义名称不会被游戏翻译');
            } else if (node.function === 'set_lore' && Array.isArray(node.lore)) {
                node.lore.forEach(l => typeof l === 'string' && ctx.report(file, 'set_lore', l, '物品描述不会被游戏翻译'));
            }
            Object.values(node).forEach(walk);
        })(data);
        return false;
    }

    // ---------------------------------------------------------------
    //  JSON UI
    // ---------------------------------------------------------------

    // 原版模板中会被当作显示文字的变量
    const BUILTIN_TEXT_VARS = new Set([
        'text', 'button_text', 'title_text', 'label_text', 'toggle_label', 'option_label',
        'tab_text', 'dialog_title', 'header_text', 'description_text', 'slider_label',
        'place_holder_text', 'placeholder_text', 'dropdown_label', 'menu_title',
    ]);

    function varNameOf(key) {
        // "$foo|default" → foo
        return key.replace(/^\$/, '').split('|')[0];
    }

    /**
     * 预扫描所有 UI 文件：
     *  - 哪些 $变量 被当作 text 使用，哪些出现在表达式/绑定中
     *    （出现在表达式中的变量，翻译后会破坏比较逻辑，例如表单标题标记 "$flag"）
     *  - 每个变量最终被哪些标签显示（用于检查 "localize": false）
     *  - 顶层控件索引（用于沿 @模板 继承查找 localize）
     * uiFiles: [{ path, data }]
     */
    function collectUiVarUsage(uiFiles) {
        const textVars = new Set(BUILTIN_TEXT_VARS);
        const nonText = new Set();
        const alias = [];          // [被赋值的变量, 引用的变量]
        const consumers = new Map(); // 变量名 → [{ obj, key, ns, path }]（"text": "$变量" 的标签）
        const elements = new Map();  // "命名空间.控件名" → { obj, key, ns }

        for (const { path, data } of uiFiles) {
            if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
            const ns = typeof data.namespace === 'string' ? data.namespace : '';
            for (const [k, v] of Object.entries(data)) {
                if (k !== 'namespace' && v && typeof v === 'object' && !Array.isArray(v)) {
                    elements.set(`${ns}.${k.split('@')[0]}`, { obj: v, key: k, ns });
                }
            }
            (function walk(node, nodeKey) {
                if (Array.isArray(node)) { node.forEach(n => walk(n, nodeKey)); return; }
                if (!node || typeof node !== 'object') return;
                for (const [k, v] of Object.entries(node)) {
                    if (typeof v === 'string') {
                        const exact = /^\$([A-Za-z0-9_]+)$/.exec(v.trim());
                        if (exact) {
                            if (k === 'text') {
                                textVars.add(exact[1]);
                                if (!consumers.has(exact[1])) consumers.set(exact[1], []);
                                consumers.get(exact[1]).push({ obj: node, key: nodeKey, ns, path });
                            } else if (k.startsWith('$')) alias.push([varNameOf(k), exact[1]]);
                            else nonText.add(exact[1]);
                            continue;
                        }
                        const re = /\$([A-Za-z0-9_]+)/g;
                        let m;
                        while ((m = re.exec(v))) nonText.add(m[1]);
                    } else if (Array.isArray(v)) {
                        // controls: [{ "名字@模板": {...} }]
                        v.forEach(item => {
                            if (item && typeof item === 'object' && !Array.isArray(item)) {
                                const keys = Object.keys(item);
                                if (keys.length === 1 && item[keys[0]] && typeof item[keys[0]] === 'object') walk(item[keys[0]], keys[0]);
                                else walk(item, nodeKey);
                            }
                        });
                    } else {
                        walk(v, k);
                    }
                }
            })(data, '');
        }
        // 变量透传："$a": "$b" → 赋给 $a 的值最终也由 $b 的标签显示
        let grew = true;
        while (grew) {
            grew = false;
            for (const [a, b] of alias) {
                if (textVars.has(a) && !textVars.has(b)) { textVars.add(b); grew = true; }
                const ca = consumers.get(a);
                if (ca) {
                    if (!consumers.has(b)) consumers.set(b, []);
                    const cb = consumers.get(b);
                    for (const c of ca) if (!cb.includes(c)) { cb.push(c); grew = true; }
                }
            }
        }
        return { textVars, nonText, consumers, elements };
    }

    /**
     * 变量 $name 在控件 obj（及其继承的模板、子控件引用的模板）里是否被“非文字”地使用：
     * 出现在表达式 / 绑定里，或赋给 text 以外的属性。变量只向下传递，所以只看这棵子树。
     * 子控件自己重新赋值了 $name 的，那一支不算。
     */
    function varMisused(obj, key, ns, name, elements, seen = new Set()) {
        const sig = `${key}|${ns}|${name}`;
        if (seen.has(sig) || seen.size > 400) return false;
        seen.add(sig);
        const tplOf = (k, curNs) => {
            if (!k || !k.includes('@')) return null;
            const ref = k.split('@')[1];
            if (ref.startsWith('$')) return null;
            return elements && elements.get(ref.includes('.') ? ref : `${curNs}.${ref}`);
        };
        const re = new RegExp('\\$' + name + '(?![A-Za-z0-9_])');
        const visit = (node, curNs) => {
            if (Array.isArray(node)) return node.some(n => visit(n, curNs));
            if (!node || typeof node !== 'object') return false;
            for (const [k, v] of Object.entries(node)) {
                if (typeof v === 'string') {
                    if (!re.test(v)) continue;
                    const exact = v.trim() === '$' + name;
                    if (exact && k === 'text') continue;
                    if (exact && k.startsWith('$')) {        // 透传给另一个变量 → 看那个变量怎么用
                        if (varMisused(node, '', curNs, varNameOf(k), elements, seen)) return true;
                        continue;
                    }
                    return true;
                }
                if (Array.isArray(v)) {
                    for (const item of v) {
                        if (!item || typeof item !== 'object' || Array.isArray(item)) { if (visit(item, curNs)) return true; continue; }
                        const ks = Object.keys(item);
                        if (ks.length === 1 && item[ks[0]] && typeof item[ks[0]] === 'object' && !Array.isArray(item[ks[0]])) {
                            const ck = ks[0], child = item[ks[0]];
                            if (Object.keys(child).some(x => x.startsWith('$') && varNameOf(x) === name && !x.includes('|default'))) continue;
                            if (visit(child, curNs)) return true;
                            const t = tplOf(ck, curNs);
                            if (t && varMisused(t.obj, t.key, t.ns, name, elements, seen)) return true;
                        } else if (visit(item, curNs)) return true;
                    }
                    continue;
                }
                if (v && typeof v === 'object') {
                    if (k.startsWith('$')) { if (visit(v, curNs)) return true; continue; }
                    if (Object.keys(v).some(x => x.startsWith('$') && varNameOf(x) === name && !x.includes('|default'))) continue;
                    if (visit(v, curNs)) return true;
                    const t = tplOf(k, curNs);
                    if (t && varMisused(t.obj, t.key, t.ns, name, elements, seen)) return true;
                }
            }
            return false;
        };
        if (visit(obj, ns)) return true;
        const base = tplOf(key, ns);
        return !!(base && varMisused(base.obj, base.key, base.ns, name, elements, seen));
    }

    /** 创造物品栏里隐藏的物品 / 方块（menu_category.category 为 none，或标了 is_hidden_in_commands）：多为技术用途 */
    function isHiddenFromCreative(desc) {
        const mc = desc && desc.menu_category;
        if (!mc || typeof mc !== 'object') return false;
        return String(mc.category || '').toLowerCase() === 'none' || mc.is_hidden_in_commands === true;
    }

    /** 沿 "名字@命名空间.模板" 继承链查找 localize；未设置返回 undefined */
    function effectiveLocalize(obj, key, ns, elements, depth = 0) {
        if (obj && typeof obj.localize === 'boolean') return obj.localize;
        if (depth > 15 || !key || !key.includes('@') || !elements) return undefined;
        const ref = key.split('@')[1];
        const full = ref.includes('.') ? ref : `${ns}.${ref}`;
        const tpl = elements.get(full);
        if (!tpl) return undefined;
        return effectiveLocalize(tpl.obj, tpl.key, tpl.ns, elements, depth + 1);
    }

    function processUI(data, file, ctx, info) {
        const fileName = file.split('/').pop().toLowerCase();
        if (fileName === '_ui_defs.json') return false;
        const usage = info.uiVarUsage || { textVars: BUILTIN_TEXT_VARS, nonText: new Set(), consumers: new Map(), elements: new Map() };
        const dirty = info.uiDirty || (info.uiDirty = new Set());
        const ns = typeof data.namespace === 'string' ? data.namespace : '';
        const fileBase = fileBaseOf(file);
        let changed = false;

        const okText = (v) => {
            if (typeof v !== 'string' || isEmptyText(v)) return false;
            const t = v.trim();
            if (/^[#$@]/.test(t)) return false;              // 绑定 / 变量引用
            if (/\$[A-Za-z_]|#[A-Za-z_]/.test(t)) return false; // 含引用的表达式
            if (/^\(.*\)$/s.test(t)) return false;           // 表达式
            if (/^\|.*\|$/.test(t)) return false;            // |TOKEN| 形式的标记
            if (!NS.hasCJK(t) && (NS.stripFormatting(t).match(/\p{L}/gu) || []).length < 2) return false; // 单个字母如 "X"
            if (ctx.isKey(t)) { ctx.ref(t, file); return false; }
            return looksLikeText(t, 'loose');
        };

        // 显示这段文字的标签如果是 "localize": false，键会被原样显示 → 改成 true
        const ensureLocalized = (obj, key, objNs, path) => {
            if (effectiveLocalize(obj, key, objNs, usage.elements) === false) {
                obj.localize = true;
                dirty.add(path);
                info.localizeFlips = (info.localizeFlips || 0) + 1;
            }
        };

        (function walk(node, ctrl, nodeKey) {
            if (Array.isArray(node)) { node.forEach(n => walk(n, ctrl, nodeKey)); return; }
            if (!node || typeof node !== 'object') return;
            for (const [k, v] of Object.entries(node)) {
                if (typeof v === 'string') {
                    if (k === 'text' && okText(v)) {
                        node[k] = ctx.alloc(`ui.${fileBase}.${ctrl}`, v, { file, kind: 'ui', scope: 'ui' });
                        ensureLocalized(node, nodeKey, ns, file);
                        changed = true;
                    } else if (k.startsWith('$')) {
                        const name = varNameOf(k);
                        // 只看这个控件（及其模板）里变量怎么用；别处同名变量用在表达式里不影响这里
                        const misused = usage.elements && usage.elements.size
                            ? varMisused(node, nodeKey, ns, name, usage.elements)
                            : usage.nonText.has(name);
                        if (usage.textVars.has(name) && !misused && okText(v)) {
                            node[k] = ctx.alloc(`ui.${fileBase}.${ctrl}.${name}`, v, { file, kind: 'ui', scope: 'ui' });
                            for (const c of usage.consumers.get(name) || []) ensureLocalized(c.obj, c.key, c.ns, c.path);
                            changed = true;
                        }
                    }
                } else {
                    // 控件名："my_label@common.label" → my_label
                    const isCtrl = v && typeof v === 'object' && !Array.isArray(v) && k !== 'variables' && !k.startsWith('$');
                    walk(v, isCtrl ? sanitizeKeyPart(k.split('@')[0]) : ctrl, isCtrl ? k : nodeKey);
                }
            }
        })(data, 'root', '');
        return changed;
    }

    // ---------------------------------------------------------------
    //  manifest —— pack.name / pack.description 写到“该包自己”的 texts
    // ---------------------------------------------------------------

    function processManifest(data, file, ctx, info) {
        const header = data && data.header;
        if (!header || typeof header !== 'object') return false;
        let changed = false;
        for (const [field, key] of [['name', 'pack.name'], ['description', 'pack.description']]) {
            const v = header[field];
            if (typeof v !== 'string' || isEmptyText(v)) continue;
            if (v === key || ctx.isKey(v)) continue;
            ctx.setPackEntry(info.packRoot, key, v);
            header[field] = key;
            changed = true;
        }
        return changed;
    }

    function reportSplashes(data, file, ctx) {
        if (data && Array.isArray(data.splashes)) {
            data.splashes.forEach(s => typeof s === 'string' && ctx.report(file, 'splashes', s, '标题画面闪烁文字不支持翻译键'));
        }
        return false;
    }

    Object.assign(NS, {
        replaceKeyField, replaceRawtextField, scanCommandFields,
        processItem, processBlock, processEntity, processDialogue,
        processAnimationCommands, reportLootNames, collectUiVarUsage, processUI,
        processManifest, reportSplashes,
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
