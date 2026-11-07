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

        if (replaceKeyField(comps, 'minecraft:display_name', `item.${id}.name`, ctx, meta)) changed = true;
        const ib = comps['minecraft:interact_button'];
        if (typeof ib === 'string' && ib !== 'true' && ib !== 'false') {
            if (replaceKeyField(comps, 'minecraft:interact_button', `item.${id}.interact_button`, ctx, meta)) changed = true;
        }
        if (scanCommandFields(item.events, `item.${id}.message`, ctx, file)) changed = true;

        info.defs.items.push({ id, file, data, hasName: comps['minecraft:display_name'] != null, isDataDriven: !!item.components });
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

        const handleComps = (comps, suffix) => {
            if (!comps || typeof comps !== 'object') return;
            if (replaceKeyField(comps, 'minecraft:display_name', base + suffix, ctx, meta)) changed = true;
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
        info.defs.blocks.push({ id, file, hasName });
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

            const boss = comps['minecraft:boss'];
            if (boss && typeof boss.name === 'string' && looksLikeText(boss.name) && !ctx.isKey(boss.name)) {
                ctx.report(file, `${where} minecraft:boss.name`, boss.name, 'Boss 血条名称不保证支持翻译键，未修改');
            }
        };

        handleComps(entity.components, 'components');
        for (const [g, comps] of Object.entries(entity.component_groups || {})) handleComps(comps, `component_groups.${g}`);
        if (scanCommandFields(entity, `entity.${id}.message`, ctx, file)) changed = true;

        info.defs.entities.push({ id, file });
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
     * 预扫描所有 UI 文件：找出哪些 $变量 被当作 text 使用，哪些出现在表达式/绑定中
     * （出现在表达式中的变量，翻译后会破坏比较逻辑，例如表单标题标记 "$flag"）
     */
    function collectUiVarUsage(uiFiles) {
        const textVars = new Set(BUILTIN_TEXT_VARS);
        const nonText = new Set();
        const alias = [];   // [被赋值的变量, 引用的变量]

        const visitString = (key, v) => {
            const exact = /^\$([A-Za-z0-9_]+)$/.exec(v.trim());
            if (exact) {
                if (key === 'text') textVars.add(exact[1]);
                else if (key.startsWith('$')) alias.push([varNameOf(key), exact[1]]);
                else nonText.add(exact[1]);
                return;
            }
            const re = /\$([A-Za-z0-9_]+)/g;
            let m;
            while ((m = re.exec(v))) nonText.add(m[1]);
        };

        for (const data of uiFiles) {
            (function walk(node, parentKey) {
                if (Array.isArray(node)) { node.forEach(n => walk(n, parentKey)); return; }
                if (!node || typeof node !== 'object') return;
                for (const [k, v] of Object.entries(node)) {
                    if (typeof v === 'string') visitString(k, v);
                    else walk(v, k);
                }
            })(data, '');
        }
        // 变量透传：$a 是文本，且 "$a": "$b" → $b 也是文本
        let grew = true;
        while (grew) {
            grew = false;
            for (const [a, b] of alias) {
                if (textVars.has(a) && !textVars.has(b)) { textVars.add(b); grew = true; }
            }
        }
        return { textVars, nonText };
    }

    function processUI(data, file, ctx, info) {
        const fileName = file.split('/').pop().toLowerCase();
        if (fileName === '_ui_defs.json') return false;
        const usage = info.uiVarUsage || { textVars: BUILTIN_TEXT_VARS, nonText: new Set() };
        const fileBase = fileBaseOf(file);
        let changed = false;

        const okText = (v) => {
            if (typeof v !== 'string' || isEmptyText(v)) return false;
            const t = v.trim();
            if (/^[#$@]/.test(t)) return false;              // 绑定 / 变量引用
            if (/\$[A-Za-z_]|#[A-Za-z_]/.test(t)) return false; // 含引用的表达式
            if (/^\(.*\)$/s.test(t)) return false;           // 表达式
            if (ctx.isKey(t)) { ctx.ref(t, file); return false; }
            return looksLikeText(t, 'loose');
        };

        (function walk(node, ctrl) {
            if (Array.isArray(node)) { node.forEach(n => walk(n, ctrl)); return; }
            if (!node || typeof node !== 'object') return;
            for (const [k, v] of Object.entries(node)) {
                if (typeof v === 'string') {
                    if (k === 'text' && okText(v)) {
                        node[k] = ctx.alloc(`ui.${fileBase}.${ctrl}`, v, { file, kind: 'ui', scope: 'ui' });
                        changed = true;
                    } else if (k.startsWith('$')) {
                        const name = varNameOf(k);
                        if (usage.textVars.has(name) && !usage.nonText.has(name) && okText(v)) {
                            node[k] = ctx.alloc(`ui.${fileBase}.${ctrl}.${name}`, v, { file, kind: 'ui', scope: 'ui' });
                            changed = true;
                        }
                    }
                } else {
                    // 控件名："my_label@common.label" → my_label
                    const childCtrl = (v && typeof v === 'object' && !Array.isArray(v) && k !== 'variables' && !k.startsWith('$'))
                        ? sanitizeKeyPart(k.split('@')[0]) : ctrl;
                    walk(v, childCtrl);
                }
            }
        })(data, 'root');
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
