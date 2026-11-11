// 端到端测试：node test/run-tests.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { NS, MemFS, readDir } = require('./load');

let failed = 0, passed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

// ---------------------------------------------------------------
//  RawMessage 渲染（模拟游戏显示）
// ---------------------------------------------------------------
function render(msg, lang) {
    if (msg == null) return '';
    if (typeof msg === 'string') return msg;
    if (Array.isArray(msg.rawtext)) return msg.rawtext.map(n => render(n, lang)).join('');
    if ('text' in msg) return msg.text;
    if (msg.translate) {
        let v = lang.get(msg.translate);
        if (v === undefined) return `<<缺失 ${msg.translate}>>`;
        v = v.replace(/\\n/g, '\n');
        const args = msg.with ? (Array.isArray(msg.with) ? msg.with : msg.with.rawtext.map(a => render(a, lang))) : [];
        return v.replace(/%(\d+)\$s/g, (_, i) => args[i - 1] ?? '').replace(/%%/g, '%');
    }
    if (msg.score || msg.selector) return `<${Object.keys(msg)[0]}>`;
    return JSON.stringify(msg);
}

function renderCommand(cmd, lang) {
    const start = NS.findCommandStart(cmd);
    const head = cmd.slice(0, start);
    const m = /^(titleraw|tellraw|title)\s+(@\w+|"[^"]*"|\S+)\s+(?:(title|subtitle|actionbar)\s+)?([\s\S]*)$/.exec(cmd.slice(start));
    if (!m) return cmd;
    const [, kw, target, sub, rest] = m;
    let text = rest;
    if (kw !== 'title') { try { text = render(JSON.parse(rest), lang); } catch (e) { text = '<<JSON错误>>' + rest; } }
    return `${head}${kw === 'tellraw' ? 'tellraw' : 'title'} ${target} ${sub ? sub + ' ' : ''}${text}`;
}

// ---------------------------------------------------------------
(async () => {
    const fixture = path.join(__dirname, 'fixture');
    const mem = new MemFS(readDir(fixture));
    const before = new Map(mem.files);
    const logs = [];
    const res = await NS.runPipeline(mem, { baseName: 'fixture' }, m => logs.push(m));
    const out = (p) => mem.files.get(p).toString();
    const out_ = out;
    const changed = [...mem.files.keys()].filter(p => before.get(p) !== mem.files.get(p));

    console.log('\n[1] 输出文件合法性');
    for (const p of changed) {
        if (p.endsWith('.json')) {
            let ok = true; try { JSON.parse(out(p)); } catch (e) { ok = false; }
            check(`JSON 合法: ${p}`, ok);
        } else if (p.endsWith('.js')) {
            let ok = true, err = '';
            try { globalThis.acorn.parse(out(p), { ecmaVersion: 'latest', sourceType: 'module' }); } catch (e) { ok = false; err = e.message; }
            check(`JS 可解析: ${p}`, ok, err);
        }
    }

    const zh = NS.parseLang(out('RP/texts/zh_CN.lang'));
    const en = NS.parseLang(out('RP/texts/en_US.lang'));

    console.log('\n[2] 所有引用的键都存在于 lang');
    const refKeys = new Set();
    for (const p of changed) {
        const c = out(p);
        for (const m of c.matchAll(/"translate"\s*:\s*"([^"]+)"/g)) refKeys.add(m[1]);
        for (const m of c.matchAll(/\\"translate\\":\\"([^"\\]+)\\"/g)) refKeys.add(m[1]);
        for (const m of c.matchAll(/"(?:value|display_name|interact_text|table_name|interact_button)"\s*:\s*"([^"]+)"/g)) refKeys.add(m[1]);
        if (p.endsWith('.js')) {
            const reg = /\.reg\((\[.*?\]), (\[.*?\])\);/.exec(c);
            if (reg) { JSON.parse(reg[1]).forEach(([, k]) => refKeys.add(k)); JSON.parse(reg[2]).forEach(([k]) => refKeys.add(k)); }
        }
    }
    const vanilla = /^(item\.apple\.name|action\.interact\.shear|my\.existing\.key)$/;
    const missing = [...refKeys].filter(k => !vanilla.test(k) && !zh.has(k));
    check(`引用键 ${refKeys.size} 个，zh_CN 全部覆盖`, missing.length === 0, missing.join(', '));
    const missingEn = [...refKeys].filter(k => !vanilla.test(k) && !en.has(k));
    check('en_US 全部覆盖（回退语言）', missingEn.length === 0, missingEn.join(', '));

    console.log('\n[3] 不该改的没有被改');
    const ui = JSON.parse(out('RP/ui/hud_screen.json'));
    check('UI 绑定 #hud_title_text_string 未动', ui.bind_label.text === '#hud_title_text_string');
    check('UI 已有键 gui.ok 未动', ui.key_label.text === 'gui.ok');
    check('UI 表达式中用到的 $flag_text 未动', ui.flag_panel.$flag_text === '天机表单');
    check('UI 格式码标记 $flag 未动', ui.flag_panel.$flag === '§t§j');
    check('UI $pressed_button_name 未动', ui['btn@common.button'].$pressed_button_name === 'button.menu_play');
    check('UI 文本用纯键（不是 rawtext 对象）', typeof ui.my_label.text === 'string' && zh.get(ui.my_label.text) === '欢迎来到天机');
    check('UI 两字中文“确定”也被提取', zh.get(ui.short_label.text) === '确定');
    check('UI 作为 text 使用的 $my_text 被提取', zh.get(ui['custom@hud.templ'].$my_text) === '自定义文本');
    const fn = out('BP/functions/start.mcfunction');
    check('mcfunction 注释行未动', fn.includes('# 注释 title @a title 不要动\r\n'));
    check('mcfunction tag … title 未动', fn.includes('tag @s add title\r\n'));
    check('mcfunction title times 未动', fn.includes('title @a times 10 20 10\r\n'));
    check('mcfunction 缩进与 CRLF 保留', fn.includes('\r\n  execute as @a[tag=vip,scores={x=1..}] at @s run titleraw @s subtitle '));
    {
        const j = [...fn.matchAll(/^tellraw @a (\{.*\})\r$/gm)].map(x => JSON.parse(x[1])).find(x => x.rawtext[0].text === '[');
        check('say → tellraw（默认）：保留 [发送者] 前缀，正文为翻译键', !fn.includes('say 游戏开始了') && j && j.rawtext[1].selector === '@s' && zh.get(j.rawtext[3].translate) === '游戏开始了');
        const ck = new NS.ExtractContext({}); ck.sayMode = 'keep';
        check('say 不转换模式：原样保留并记入报告', NS.translateCommand('say 游戏开始了', ck, 'k', 'f').changed === false && ck.untranslatable.some(u => u.text === '游戏开始了'));
        const ct = new NS.ExtractContext({}); ct.sayMode = 'titleraw';
        const t1 = NS.translateCommand('say 欢迎 @p 来到村庄', ct, 'k', 'f').cmd;
        check('say → titleraw：选择器变成 %1$s 参数', /^titleraw @a title /.test(t1) && [...ct.entries.values()][0].value === '欢迎 %1$s 来到村庄');
        const ca = new NS.ExtractContext({}); ca.sayMode = 'actionbar';
        check('tell @p → titleraw @p actionbar', /^titleraw @p actionbar /.test(NS.translateCommand('tell @p 小心背后', ca, 'k', 'f').cmd));
        check('say 100% / say @a 不转换', !NS.translateCommand('say 100%', ct, 'k', 'f').changed && !NS.translateCommand('say @a', ct, 'k', 'f').changed);
    }
    check('计分板显示名记入报告', res.ctx.untranslatable.some(u => u.text === '击杀数'));
    check('战利品表 set_name 未改（游戏不翻译自定义名称）', !changed.includes('BP/loot_tables/chest.json') && res.ctx.untranslatable.some(u => u.text === '传说宝箱'));
    const ent = JSON.parse(out('BP/entities/merchant.json'))['minecraft:entity'];
    check('实体 nameable.name_filter 未动', ent.components['minecraft:nameable'].name_actions[0].name_filter === 'Toast');
    check('实体 boss 血条名 → 翻译键（游戏内实测有效）', zh.get(ent.components['minecraft:boss'].name) === '神秘商人BOSS' && !res.ctx.untranslatable.some(u => u.text === '神秘商人BOSS'));
    check('已有键 action.interact.shear 未动', ent.components['minecraft:interact'].interactions[1].interact_text === 'action.interact.shear');
    const ac = JSON.parse(out('BP/animation_controllers/ac.json'));
    const onEntry = ac.animation_controllers['controller.animation.tianji.fight'].states.fight.on_entry;
    check('动画控制器事件/Molang 未动', onEntry[1] === '@s tianji:event' && onEntry[2] === 'v.x = 1;');
    check('textField 的 defaultValue 未登记', ![...zh.values()].includes('Steve'));
    check('图片路径未登记', ![...zh.values()].some(v => v.includes('textures/')));

    const st = JSON.parse(out('RP/ui/starter.json'));
    check('localize:false 的标签：直接文本被翻译并改为 localize:true', zh.get(st.title_label.text) === '就决定是你了！' && st.title_label.localize === true);
    check('localize:false 的标签：通过 $变量 传入的文本 → 显示它的标签改为 true', zh.get(st.frame.controls[0]['bulbasaur@starter.state'].$name) === '妙蛙种子' && st.state.controls[0].name_label.localize === true);
    check('localize:false 继承自 @模板 → 在子控件上覆盖为 true', st.state.controls[1]['desc@starter.desc_tpl'].localize === true);
    check('单个字母 "X" 不提取', st.x_btn.text === 'X');

    {
        const cp = new NS.ExtractContext({});
        const blk = { format_version: '1.21.0', 'minecraft:block': { description: { identifier: 'nico:spawner' }, components: { 'minecraft:display_name': '%tile.nico.spawner.name' } } };
        const chg = NS.processBlock(blk, 'BP/blocks/s.json', cp, { defs: { blocks: [], items: [], entities: [] } });
        check('"%键名" 视为已有键：不改、不新建键，引用记为去掉 % 的键', !chg && blk['minecraft:block'].components['minecraft:display_name'] === '%tile.nico.spawner.name' && cp.entries.size === 0 && cp.referenced.has('tile.nico.spawner.name'));
        check('"%1$s 来了" / "100%" 不当作键', !cp.isKey('%1$s 来了') && !cp.isKey('100%'));
    }
    {
        // 多行模板带代码缩进，显示前先 trim 每行（DLCraft 的 Simple Waystone 帮助文本）
        const src = 'export function help(player){\n        const message = `§a<Waystone Commands>\n                o /scriptevent sw:delete - Deletes all waystones.\n                `;\n        player.sendMessage(message.split("\\n").map(l => l.trim()).join("\\n"));\n}';
        for (const split of [false, true]) {
            const cw = new NS.ExtractContext({ splitNewlines: split });
            const r = NS.processScript(src, 'scripts/w.js', cw, { injectRuntime: true });
            const sent = [];
            require('vm').runInNewContext(r.content.replace(/export /g, '') + '\nhelp(player);', { globalThis: {}, player: { sendMessage: (m) => sent.push(m) } });
            const vals = [...cw.entries.values()].map(e => e.value);
            check(`带缩进的多行文本：lang 去掉代码缩进，trim 后仍能翻译（${split ? '拆键' : '一个键'}）`,
                vals.every(v => !/\n /.test(v) && !/^ /.test(v)) && sent[0].rawtext.filter(x => x.translate).length === (split ? 2 : 1) && !sent[0].rawtext.some(x => x.text && /Deletes/.test(x.text)));
        }
    }
    {
        check('占位符混用：%3$s + %s %s → %3$s + %1$s %2$s', NS.fixMixedPlaceholders('使用 %3$s 需要 §9%s %s §f的知识') === '使用 %3$s 需要 §9%1$s %2$s §f的知识'
            && NS.fixMixedPlaceholders('%s 和 %s') === null && NS.fixMixedPlaceholders('%1$s 100%% %s') === '%1$s 100%% %2$s');
        const fm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        fm.files.set('RP/texts/zh_CN.lang', Buffer.from('## 注释 %s %1$s\nmix.test=使用 %2$s 需要 %s 的知识\nok.test=%s 和 %s\n'));
        await NS.runPipeline(fm, { baseName: 'fixture' }, () => {});
        const zl = NS.parseLang(fm.files.get('RP/texts/zh_CN.lang').toString());
        check('  └ 转换时自动修正已有译文中的混用占位符', zl.get('mix.test') === '使用 %2$s 需要 %1$s 的知识' && zl.get('ok.test') === '%s 和 %s' && fm.files.get('RP/texts/zh_CN.lang').toString().startsWith('## 注释 %s %1$s'));
    }
    {
        // DLCraft：cancelEvent(..., sourceName = 'item') 把参数拼进提示文字，调用处传 'block'
        const pm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        pm.files.set('BP/scripts/req_utils.js', Buffer.from("import { system } from '@minecraft/server';\nexport const cancelEvent = (source, player, e, sourceName = 'item') => {\n  system.run(() => player.onScreenDisplay.setActionBar(`§4Required §9Knowledge of ${source.skill} ${source.level} §fto use the ${sourceName}`));\n};\n"));
        pm.files.set('BP/scripts/req_events.js', Buffer.from("import { cancelEvent } from './req_utils.js';\nexport function f(block, player, e) { cancelEvent(block, player, e, 'block'); cancelEvent(block, player, e, 'minecraft:stone'); }\n"));
        const pr = await NS.runPipeline(pm, { baseName: 'fixture', splitNewlines: false }, () => {});
        const vals = [...pr.ctx.entries.values()].filter(e => /req_utils/.test(e.file)).map(e => e.value);
        const js = pm.files.get('BP/scripts/req_utils.js').toString();
        check('函数参数拼进提示文字：默认值 item 和调用处传入的 block 也登记翻译', vals.includes('item') && vals.includes('block') && !vals.includes('minecraft:stone') && /\["item","script\.req_utils\.word/.test(js));
    }
    {
        // 创造物品栏隐藏的物品 / 方块、不显示的刷怪蛋：默认不提取、不补全；勾选后照常
        const mk = () => {
            const m = new MemFS(readDir(path.join(__dirname, 'fixture')));
            m.files.set('BP/items/adv.json', Buffer.from(JSON.stringify({ format_version: '1.21.50', 'minecraft:item': { description: { identifier: 'mm:alyadvancement_big_shot', menu_category: { category: 'none', is_hidden_in_commands: true } }, components: { 'minecraft:icon': 'stick', 'minecraft:display_name': { value: 'item.mm:alyadvancement_big_shot.name' } } } })));
            m.files.set('BP/items/tech.json', Buffer.from(JSON.stringify({ format_version: '1.21.50', 'minecraft:item': { description: { identifier: 'mm:tech_marker', menu_category: { category: 'none' } }, components: { 'minecraft:display_name': { value: 'Technical Marker' } } } })));
            m.files.set('BP/items/sword.json', Buffer.from(JSON.stringify({ format_version: '1.21.50', 'minecraft:item': { description: { identifier: 'mm:real_sword', menu_category: { category: 'equipment' } }, components: { 'minecraft:display_name': { value: 'Real Sword' } } } })));
            m.files.set('BP/blocks/hb.json', Buffer.from(JSON.stringify({ format_version: '1.21.50', 'minecraft:block': { description: { identifier: 'mm:hidden_block', menu_category: { category: 'none' } }, components: { 'minecraft:display_name': 'Hidden Block' } } })));
            m.files.set('BP/entities/dummy.json', Buffer.from(JSON.stringify({ format_version: '1.21.50', 'minecraft:entity': { description: { identifier: 'mm:dummy', is_spawnable: false }, components: {} } })));
            m.files.set('RP/entity/dummy.json', Buffer.from(JSON.stringify({ format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: 'mm:dummy', spawn_egg: { base_color: '#ff0000', overlay_color: '#00ff00' } } } })));
            const en = m.files.get('RP/texts/en_US.lang');
            m.files.set('RP/texts/en_US.lang', Buffer.from((en ? en.toString() : '') + '\nitem.mm:alyadvancement_big_shot.name=Big Shot\nitem.spawn_egg.entity.mm:dummy.name=Spawn Dummy\n'));
            return m;
        };
        const m1 = mk();
        const r1 = await NS.runPipeline(m1, { baseName: 'fixture', targetLangs: ['en_US', 'zh_CN'] }, () => {});
        const v1 = [...r1.ctx.entries.values()].map(e => e.value);
        const zh1 = m1.files.get('RP/texts/zh_CN.lang').toString();
        check('隐藏物品：默认不提取创造栏隐藏的物品 / 方块名，不补全它们和不显示刷怪蛋的已有键',
            v1.includes('Real Sword') && !v1.includes('Technical Marker') && !v1.includes('Hidden Block') && !/alyadvancement_big_shot|spawn_egg\.entity\.mm:dummy/.test(zh1)
            && /"Technical Marker"/.test(m1.files.get('BP/items/tech.json').toString()), JSON.stringify(v1));
        const m2 = mk();
        const r2 = await NS.runPipeline(m2, { baseName: 'fixture', targetLangs: ['en_US', 'zh_CN'], includeHiddenItems: true }, () => {});
        const v2 = [...r2.ctx.entries.values()].map(e => e.value);
        const zh2 = m2.files.get('RP/texts/zh_CN.lang').toString();
        check('  └ 勾选后照常提取和补全', v2.includes('Technical Marker') && v2.includes('Hidden Block') && /item\.mm:alyadvancement_big_shot\.name=Big Shot/.test(zh2) && /spawn_egg\.entity\.mm:dummy/.test(zh2));
    }
    {
        // PalCraft 小地图：每 tick 把字形画传给 setActionBar，运行时模糊匹配不能回溯卡死（Watchdog hang）
        const cx = new NS.ExtractContext({});
        const out = NS.processScript('import { world } from "@minecraft/server";\nexport function f(p, a) { p.onScreenDisplay.setActionBar(a); }\n', 'scripts/x.js', cx, { injectRuntime: true }).content;
        const rt = new Function(out.slice(0, out.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '') + '\nreturn __i18n;')();
        const pats = [];
        for (let i = 0; i < 300; i++) pats.push(['k.p' + i, ['Player ', ' dealt ', ' damage number ' + i + ' to ', ''], null]);
        pats.push(['k.adj', ['', '', '', ' took damage'], null], ['k.sp', ['', ' ', ' ', ''], null]);
        rt.reg([['Hello there friend', 'k.hello']], pats, []);
        const t0 = Date.now();
        for (let f = 0; f < 20; f++) {
            const rows = [];
            for (let r = 0; r < 12; r++) { let l = ''; for (let c = 0; c < 60; c++) l += (c % 5 ? '' : '§' + 'abcdef'[c % 6]) + String.fromCharCode(0xe000 + ((f * 7 + r * 13 + c) % 200)); rows.push(l); }
            rt.M(rows.join('\n'));
        }
        rt.M('§a' + 'x'.repeat(3000) + ' took damage');
        const dt = Date.now() - t0;
        const hit = JSON.stringify(rt.M('Player Steve dealt 5 damage number 7 to Zombie'));
        check('运行时：字形画 / 超长字符串不做模糊匹配，不会卡死；句式照常匹配', dt < 300 && /"k\.p7"/.test(hit) && /k\.hello/.test(JSON.stringify(rt.M('§aHello there friend§r'))), dt + 'ms');
    }
    {
        // 已转换的附加包再转换：脚本不重复处理，但运行时换成当前版本
        const conv = NS.processScript('import { world } from "@minecraft/server";\nconst NAMES = { a: "Punch Flurry" };\nexport function f(p, k) { p.sendMessage(NAMES[k]); }\n', 'scripts/old.js', new NS.ExtractContext({}), { injectRuntime: true, runtimeKey: '__ADDON_I18N_old' }).content;
        const old = conv.replace(', FUZZY_MAX = 600', '');   // 模拟旧版运行时
        if (old === conv) throw new Error('测试数据没有构造出旧运行时');
        const pm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        pm.files.set('BP/scripts/old.js', Buffer.from(old));
        const pr = await NS.runPipeline(pm, { baseName: 'fixture' }, () => {});
        const now = pm.files.get('BP/scripts/old.js').toString();
        check('已转换脚本：运行时更新到当前版本，登记和代码不变', now.includes('FUZZY_MAX') && now.split('// ---- end i18n runtime ----')[1] === old.split('// ---- end i18n runtime ----')[1]
            && (now.match(/__i18n\.reg\(/g) || []).length === 1 && pr.ctx.warnings.some(w => /运行时已更新/.test(w)));
    }
    {
        // PalCraft：HUD 字段拼成固定长度纯 ASCII 字符串，界面按位置截取 → 流进去的文字无法本地化
        const pm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        pm.files.set('BP/scripts/hud/protocol.js', Buffer.from("export const FIELDS = [['name', 20], ['status', 18], ['hint', 28], ['baseTitle', 16], ['baseNeeds', 32]];\nexport function encode(values) { return FIELDS.map(([k, w]) => String(values[k] ?? '').replace(/[^\\x20-\\x7e]|[~|:]/g, '?').padEnd(w, '~')).join(''); }\n"));
        pm.files.set('BP/scripts/hud/party.js', Buffer.from("import { translateText } from '../i18n.js';\nfunction nameOf(player, pal) { if (!pal) return translateText(player, 'Sin companero'); return pal.name; }\nexport function partyFields(player, pal) { return { name: nameOf(player, pal), status: translateText(player, 'EQUIPO 0/5'), hint: translateText(player, pal ? 'Listo para luchar' : 'BUSCA UN PAL SALVAJE') }; }\nexport function warn(player) { player.sendMessage('Your team is full right now'); }\n"));
        pm.files.set('BP/scripts/hud/presentation.js', Buffer.from("import { translateText } from '../i18n.js';\nconst plain = (t, n) => String(t ?? '').replace(/[^\\x20-\\x7e]/g, ' ').slice(0, n);\nexport function baseFields(player) { return { baseAction: plain(translateText(player, 'Parcela lista'), 36) }; }\n"));
        pm.files.set('BP/scripts/i18n/hud.js', Buffer.from("export default [\n ['Sin companero', 'No partner'],\n ['EQUIPO 0/5', 'TEAM 0/5'],\n ['BUSCA UN PAL SALVAJE', 'FIND A WILD PAL'],\n ['Parcela lista', 'Plot ready'],\n ['El equipo esta lleno ahora', 'Your team is full right now'],\n];\n"));
        const pr = await NS.runPipeline(pm, { baseName: 'fixture' }, () => {});
        const vals = [...pr.ctx.entries.values()].map(e => e.value);
        const un = pr.ctx.untranslatable.filter(u => /ASCII/.test(u.reason)).map(u => u.text);
        check('ASCII 数据包 HUD：流进字段的文字及对照表同一行不提取，列入无法本地化；聊天文字照常',
            !['Sin companero', 'No partner', 'EQUIPO 0/5', 'TEAM 0/5', 'FIND A WILD PAL', 'Parcela lista', 'Plot ready', 'Listo para luchar'].some(t => vals.includes(t))
            && vals.includes('Your team is full right now') && un.includes('No partner') && un.includes('Parcela lista'), JSON.stringify(vals.filter(v => /[A-Za-z]/.test(v)).slice(-12)));
    }
    {
        // 语言文件黑名单：模板残留条目删除；包里定义了实体 / 引用了键 / 值改过的保留
        const mk = (extra) => {
            const m = new MemFS(readDir(path.join(__dirname, 'fixture')));
            const en = (m.files.get('RP/texts/en_US.lang') || '').toString();
            m.files.set('RP/texts/en_US.lang', Buffer.from(en + '\nitem.spawn_egg.entity.pa:crab.name=Spawn Crab\nentity.animal:bear.name=Bear\naccessibility.disableTTS=Text To Speech disabled\nitem.spawn_egg.entity.pa:shark.name=Spawn Shark\nentity.animal:duck.name=Pato\naction.interact.sit = Sit\t#\naction.interact.rotar=Rotate\t#\n'));
            m.files.set('RP/texts/zh_CN.lang', Buffer.from('item.spawn_egg.entity.pa:crab.name=生成螃蟹\nentity.animal:bear.name=熊\n'));
            m.files.set('BP/entities/shark.json', Buffer.from(JSON.stringify({ format_version: '1.21.0', 'minecraft:entity': { description: { identifier: 'pa:shark', is_spawnable: true }, components: { 'minecraft:interact': { interactions: [{ interact_text: 'action.interact.sit' }] } } } })));
            return m;
        };
        const m1 = mk();
        await NS.runPipeline(m1, { baseName: 'fixture', targetLangs: ['en_US', 'zh_CN', 'ja_JP'] }, () => {});
        const en1 = m1.files.get('RP/texts/en_US.lang').toString(), zh1 = m1.files.get('RP/texts/zh_CN.lang').toString(), ja1 = (m1.files.get('RP/texts/ja_JP.lang') || '').toString();
        check('语言黑名单：模板残留条目从所有语言删除且不补全；定义了的实体、被引用的键、改过的值保留',
            !/pa:crab|animal:bear|disableTTS|interact\.rotar/.test(en1 + zh1 + ja1) && /pa:shark\.name=Spawn Shark/.test(en1) && /animal:duck\.name=Pato/.test(en1) && /action\.interact\.sit/.test(en1), en1.slice(-300));
        const m2 = mk();
        await NS.runPipeline(m2, { baseName: 'fixture', removeJunkLang: false }, () => {});
        check('  └ 关闭选项后不删除', /pa:crab/.test(m2.files.get('RP/texts/en_US.lang').toString()));
    }
    {
        // 最低可用版本
        const MV = NS.MinVersion;
        check('最低版本：脚本 API 对照（稳定版 / 新编号 / 测试版）',
            MV.label(MV.serverModuleGame('2.0.0').game) === '1.21.90' && MV.label(MV.serverModuleGame('2.6.0').game) === '26.10'
            && MV.serverModuleGame('2.1.0-beta').beta && MV.label(MV.serverModuleGame('2.1.0-beta').game) === '1.21.90' && MV.serverModuleGame('2.30.0').newer);
        const pm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const man = NS.parseJsonLenient(pm.files.get('BP/manifest.json').toString());
        man.header.min_engine_version = [1, 20, 0];
        man.dependencies = (man.dependencies || []).filter(d => d.module_name !== '@minecraft/server').concat([{ module_name: '@minecraft/server', version: '1.16.0' }]);
        pm.files.set('BP/manifest.json', Buffer.from(JSON.stringify(man)));
        pm.files.set('BP/items/newer.json', Buffer.from('{"format_version": "1.21.60", "minecraft:item": {"description": {"identifier": "t:newer"}, "components": {}}}'));
        const pr = await NS.runPipeline(pm, { baseName: 'fixture' }, () => {});
        const mv = pr.summary.minVersion;
        check('最低版本：附加包取 min_engine_version / 脚本 API / format_version 中最高的', mv && mv.label === '1.21.60' && mv.basis.some(b => b.k === 'script' && b.v === '1.21.50') && mv.basis.some(b => b.k === 'engine'), JSON.stringify(mv));
        const T = NS.NBT.T;
        const lvl = [{ t: T.LIST, n: 'MinimumCompatibleClientVersion', v: { et: T.INT, items: [1, 21, 50, 0, 0] } }, { t: T.LIST, n: 'lastOpenedWithVersion', v: { et: T.INT, items: [1, 21, 80, 3, 0] } }];
        const w = MV.estimateWorld(lvl);
        const merged = MV.mergeWorld(w, { version: [1, 21, 90], label: '1.21.90', basis: [], beta: null });
        check('最低版本：存档读 level.dat，自带包要求更高时取更高', w.label === '1.21.50' && w.lastOpened === '1.21.80' && merged.label === '1.21.90' && merged.basis.some(b => b.k === 'packs'));
    }
    check('只有 %键名 引用的文本不提取（JSON UI 常见）', !NS.looksLikeText('§z(%deesse.caseSensitive)') && !NS.looksLikeText('<%menu.serverGenericName> %progressScreen.saving')
        && NS.looksLikeText('欢迎 %1$s') && NS.looksLikeText('Saving %menu.world now') && NS.looksLikeText('打开 %gui.done'));
    check('带重音字母的键名（déesse.extPacks.title）视为已有键', NS.isLikelyKey('déesse.extPacks.title') && NS.isLikelyKey('déesse.compability.gamepad.desc_1') && !NS.isLikelyKey('Déesse CORE (core)') && !NS.isLikelyKey('é.1'));
    {
        // Déesse UI：别的模板把 $text 拼进表达式，不应影响只把 $text 当标签文字的模板
        const vm2 = new MemFS(readDir(path.join(__dirname, 'fixture')));
        vm2.files.set('RP/ui/v_common.json', Buffer.from(JSON.stringify({ namespace: 'vc',
            text_desc: { type: 'label', text: '$text' },
            hash_label: { type: 'label', text: "('§z#' + $text)" },
            wrapper: { type: 'panel', controls: [{ 'inner@vc.hash_label': {} }] } })));
        vm2.files.set('RP/ui/v_page.json', Buffer.from(JSON.stringify({ namespace: 'vp',
            a: { type: 'panel', controls: [{ 'list@vc.text_desc': { $text: '- Quick Container' } }, { 'h@vc.hash_label': { $text: 'Color Code' } }, { 'w@vc.wrapper': { $text: 'Wrapped Hash' } }] } })));
        await NS.runPipeline(vm2, { baseName: 'fixture' }, () => {});
        const vp = JSON.parse(vm2.files.get('RP/ui/v_page.json').toString()).a.controls;
        check('UI 变量按模板判断：只当标签文字的提取，拼进表达式的（含子控件模板里）不提取',
            vp[0]['list@vc.text_desc'].$text !== '- Quick Container' && vp[1]['h@vc.hash_label'].$text === 'Color Code' && vp[2]['w@vc.wrapper'].$text === 'Wrapped Hash');
    }
    {
        // Bedrock Reimagined：每种语言一个字典，Ns("en_US", a, b) 登记；u(lang, key, ...args) 用 {0} 填参数
        const src = `var a,b,c,d,X;a={"ui.play":"How to Play","ui.lang":"§aLanguage set to {0}","ui.only":"Back"};
c={"ui.play":"遊び方","ui.lang":"§a言語を {0} に設定しました"};
d={"ui.play":"Как играть","ui.lang":"§aЯзык: {0}","ui.extra":"Секвойный олень","ui.old_ring":"Кольцо обжорства"};
function Ns(e,...t){let m=X.get(e);m||(m=new Map,X.set(e,m));for(let i of t)for(let n in i)m.set(n,i[n])}
X=new Map;Ns("en_US",a);Ns("ja_JP",c);Ns("ru_RU",d);
function u(e,t,...r){let n=X.get(e)?.get(t)??X.get("en_US").get(t);for(let i=0;i<r.length;i++)n=n.replaceAll("{"+i+"}",String(r[i]));return n}
export function show(p, lang){ p.sendMessage(u(lang,"ui.play")); p.sendMessage(u(lang,"ui.lang","日本語")); }
function extra(p, lang){ p.sendMessage(u(lang,"ui.extra")); }`;
        const cd = new NS.ExtractContext({});
        const r = NS.processScript(src, 'scripts/imports.js', cd, { injectRuntime: true });
        const byVal = (v) => [...cd.entries].find(([, e]) => e.value === v);
        const play = byVal('How to Play'), lang = byVal('§aLanguage set to %1$s'), extra = byVal('Секвойный олень');
        const tr = (k, l) => cd.translations.get(k) && cd.translations.get(k).get(l);
        const sent = [];
        require('vm').runInNewContext(r.content.replace(/export /g, '') + '\nshow(p,"ja_JP");show(p,"ru_RU");', { globalThis: {}, p: { sendMessage: (m) => sent.push(m) } });
        check('按语言登记的字典（Ns("en_US", 字典)）：各语言共用一个键，{0} → %1$s',
            play && lang && tr(play[0], 'ja_JP') === '遊び方' && tr(play[0], 'ru_RU') === 'Как играть' && tr(lang[0], 'ja_JP') === '§a言語を %1$s に設定しました'
            && extra && tr(extra[0], 'ru_RU') === 'Секвойный олень' && !byVal('遊び方') && !byVal('Как играть'));
        check('  └ 只在俄文字典里、代码没用到的残留键（改名前的旧键）不提取', !byVal('Кольцо обжорства') && cd.warnings.some(w => /残留/.test(w)));
        check('  └ 运行时：脚本按自己的语言取出的日文/俄文也能对应到同一个键（含参数）',
            sent.length === 4 && sent[0].rawtext[0].translate === play[0] && sent[2].rawtext[0].translate === play[0]
            && sent[1].rawtext[0].translate === lang[0] && sent[3].rawtext[0].translate === lang[0] && sent[1].rawtext[0].with.rawtext.length === 1);
    }
    {
        // 调试输出不提取（Alylica's Dungeon 的 debug 标签、DEBUG 开关、调试函数）
        const src = [
            'import { world, system } from "@minecraft/server";',
            'world.afterEvents.entityHurt.subscribe((e) => {',
            '  const hurt = e.hurtEntity, d = 1;',
            '  if (hurt.hasTag("dungeons:debug_damage")) hurt.sendMessage(`§eYou§7 took: ${d}§7 Damage`);',
            '  for (const p of world.getPlayers({ tags: ["dungeons:debug_damage"] })) p.sendMessage(`Dealt: ${d} Damage`);',
            '  hurt.sendMessage("You were hurt badly");',
            '});',
            'system.runInterval(() => { for (const p of world.getAllPlayers()) {',
            '  if (!p.hasTag("dungeons:debug_showstates")) continue;',
            '  p.onScreenDisplay.setActionBar(`Block: ${p.name}, Face: up`);',
            '} });',
            'const DEBUG = false;',
            'function debugLog(p, m) { p.sendMessage("Debug note: " + m); }',
            'export function f(p) {',
            '  if (DEBUG) p.sendMessage("Cooldown state dump");',
            '  if (!DEBUG) p.sendMessage("Welcome to the dungeon");',
            '  debugLog(p, "Spawner tick happened");',
            '  p.sendMessage(DEBUG ? "debug mode text" : "Normal mode text");',
            '}',
            'const names = [{ username: "Alylicara", printName: "§dAlylicara" }];',
        ].join('\n');
        const cd = new NS.ExtractContext({});
        NS.processScript(src, 'scripts/combat.js', cd, { injectRuntime: true });
        const vals = [...cd.entries.values()].map(e => e.value).sort();
        check('调试输出：调试标签 / 开关 / 调试函数里的文本、玩家名单不提取，正常文本照常', JSON.stringify(vals) === JSON.stringify(['Normal mode text', 'Welcome to the dungeon', 'You were hurt badly']), JSON.stringify(vals));
        const cf = new NS.ExtractContext({});
        NS.processScript('export function f(p){ p.sendMessage("Took some damage now"); }', 'scripts/utils/debug.js', cf, { injectRuntime: true });
        check('调试输出：debug.js 整个文件不提取', cf.entries.size === 0);
        // PalCraft 生成的数据表：开发备注、内部标识不提取，显示名照常
        const data = 'export const A = {"x":{"label":"Punch Flurry","stat":"MeleeAttack","retailId":"WaterGun","partnerKey":"Toboggan","phase":"Ready",' +
            '"adaptation":"Existing reviewed Bedrock signature retained; power added.","nativePresentation":{"timingBasis":{"releaseGesture":"reviewed own-Pal Action pose +0.2 source seconds"},"pulseTiming":"bounded dispatch inside Process"},' +
            '"preview":{"displayName":"Fuack · Aqua Gun","chargeLabel":"High pressure water"}}};';
        const cp = new NS.ExtractContext({});
        NS.processScript(data, 'scripts/data.js', cp, { injectRuntime: true });
        const pv = [...cp.entries.values()].map(e => e.value).sort();
        check('数据表：开发备注字段、*Id / *Key / 驼峰标识符不提取', JSON.stringify(pv) === JSON.stringify(['Fuack · Aqua Gun', 'High pressure water', 'Punch Flurry']), JSON.stringify(pv));
    }
    {
        const cr = new NS.ExtractContext({});
        NS.processScript('const o = {}; o.hasOwnProperty("Rotation"); o.toString("Hello there"); item.setLore(["Sharp blade"]);', 'scripts/x.js', cr, {});
        check('报告：hasOwnProperty / toString 等原型方法名不误报', !cr.untranslatable.some(u => /hasOwnProperty|toString|native/.test(u.where + u.reason)) && cr.untranslatable.some(u => u.text === 'Sharp blade'));
        const c2 = new NS.ExtractContext({});
        ['§u', '0', 'ui:§burn0', '5fs_br:jungle_barrel.name', 'Maple Barrel'].forEach(t => c2.report('f', '实体名字标签', t, 'x'));
        check('报告：格式码、数字、技术 ID、已有键不列入', c2.untranslatable.length === 1 && c2.untranslatable[0].text === 'Maple Barrel');
        const dm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        dm.files.set('BP/scripts/dup.js', Buffer.from('item.setLore(["Dup lore"]); item.setLore(["Dup lore"]);'));
        const dr = await NS.runPipeline(dm, { baseName: 'fixture' }, () => {});
        const dl = dr.ctx.untranslatable.filter(u => u.text === 'Dup lore');
        check('报告：同一文件同一位置同一文字合并，记录次数', dl.length === 1 && dl[0].count === 2 && dr.workbook['untranslatable.csv'].split('\n')[0].includes('count'));
    }
    {
        const ce = new NS.ExtractContext({});
        NS.processScript('e.runCommand("event entity @s[tag=5fs_br:death] 5fs_br:death"); const x = "event entity @s 5fs_br:death"; d.runCommandAsync(x); p.runCommand("Some odd text here");', 'scripts/c.js', ce, {});
        check('命令：event entity … / runCommand 里原样执行的字符串不当作文本', ce.entries.size === 0 && NS.looksLikeCommand('time set 1000') && !NS.looksLikeCommand('event entity gets angry'));
    }
    {
        // YTAUN Skill Tree：三元分支里的文字、join(", ") 拼起来的名称列表
        const src = 'const PROF={combat:{name:"Combat"},miner:{name:"Miner"}};\nexport function f(p,m,kit,mine){ p.sendMessage(`§aYour path: §f${m}§a.${kit ? " Starter kit added to your pack." : ""}§r`); p.sendMessage(`§6Branch ${m} ${mine ? "mastered" : "complete"}.`); p.sendMessage(["combat","miner"].map(x=>"§f"+PROF[x].name).join("§7, ")); }';
        const cy = new NS.ExtractContext({});
        const r = NS.processScript(src, 'scripts/ui/picker.js', cy, { injectRuntime: true });
        const vals = [...cy.entries.values()].map(e => e.value);
        const out = [];
        require('vm').runInNewContext(r.content.replace(/export /g, '') + '\nf(p,"Mage",true,false);', { globalThis: {}, p: { sendMessage: (x) => out.push(x) } });
        check('模板 ${} 里三元分支的文字也登记（" Starter kit added…"、mastered / complete）', vals.includes('Starter kit added to your pack.') && vals.includes('mastered') && vals.includes('complete'));
        check('  └ 运行时：join(", ") 拼起来的名称列表逐项翻译', JSON.stringify(out[0]).split('"translate"').length === 3 && out[2].rawtext && out[2].rawtext.filter(x => x.translate).length === 2);
    }
    {
        // YTAUN Skill Tree 原包：onLight 换颜色码、"§c" + reason、"+2.5 skill xp"、const kind = 条件 ? " only" : …
        const src = `const META={xp:["skill xp","%"]};
function onLight(t){ return String(t).replace(/§7/g,"§8"); }
function reason(c){ return { ok:false, reason: \`Needs \${c} skill point\${c > 1 ? "s" : ""}.\` }; }
function side(where, node, off){ const kind = node.ex ? " only" : node.gate ? " · gate" : " · shared"; return \`§7\${where}\${kind}§r\`; }
function stat(v){ return \`+\${v} \${META.xp[0]}\`; }
export function f(p, b){ b.button(onLight("§7Quick buy: §8OFF")); p.sendMessage("§c" + reason(2).reason); b.body(side("Archer", { ex: true })); b.body("§a" + stat(2.5) + "§r"); }`;
        const cz = new NS.ExtractContext({});
        const r = NS.processScript(src, 'scripts/ui/tree.js', cz, { injectRuntime: true });
        const vals = [...cz.entries.values()].map(e => e.value);
        const out = [];
        const sink = { sendMessage: (x) => out.push(x), button: (x) => out.push(x), body: (x) => out.push(x) };
        require('vm').runInNewContext(r.content.replace(/export /g, '') + '\nf(sink, sink);', { globalThis: {}, sink });
        const tr = (x) => x && typeof x === 'object' && JSON.stringify(x).includes('"translate"');
        check('条件常量展开成完整句式（%1$s only / · gate / · shared）', vals.includes('§7%1$s only') || vals.some(v => /%1\$s only/.test(v)) && vals.some(v => /%1\$s · gate/.test(v)));
        check('  └ 运行时：换过颜色码、前面加了颜色码的句式、数值 + 名称 都能翻译', out.length === 4 && out.every(tr), JSON.stringify(out));
    }
    {
        // YTAUN：属性表名称列 + 常量标签 "§8[flat]" + 运行时按颜色分段
        const src = `const FLAT = "§8[flat]";
const TREE = { stats: { mel: ["melee damage","flat",3,"added to every melee hit"], hp: ["max health","flat",20,"more hearts for you"], arm: ["armor","flat",10,"less damage taken from hits"] } };
function fmt(k, v){ const [label] = TREE.stats[k]; return \`+\${v} \${label} \${FLAT}\`; }
export function f(b, n){ b.body(\`§a\${fmt("hp", 2)}§r\`); b.body("§a" + fmt("arm", 2).replace(" " + FLAT, "") + "§r"); b.body(\`entit\${n > 1 ? "ies" : "y"} removed\`); }`;
        const cs = new NS.ExtractContext({});
        const r = NS.processScript(src, 'scripts/ui/tree.js', cs, { injectRuntime: true });
        const vals = [...cs.entries.values()].map(e => e.value);
        const out = [];
        require('vm').runInNewContext(r.content.replace(/export /g, '') + '\nf(b, 2);', { globalThis: {}, b: { body: (x) => out.push(x) } });
        check('属性表名称列（armor / max health）和常量标签 [flat] 登记翻译；词尾 ies 不登记', ['armor', 'max health', 'melee damage', '[flat]'].every(v => vals.includes(v)) && !vals.includes('ies') && !vals.includes('flat'));
        const js = JSON.stringify(out[0]);
        check('  └ 运行时：“§a+2 max health §8[flat]§r” 按颜色分段逐段翻译', (js.match(/"translate"/g) || []).length >= 2 && js.includes('+2 '), js);
    }
    {
        const src = 'const N={a:{name:"Tanker"},b:{name:"Demolitionist"}};\nexport function f(p){ const next=["a","b"].map(x=>N[x].name); p.sendMessage(`§7You may now start: §f${next.join("§7 or §f")}§7.§r`); }';
        const cj = new NS.ExtractContext({});
        const r = NS.processScript(src, 'scripts/ui/tree.js', cj, { injectRuntime: true });
        const out = [];
        require('vm').runInNewContext(r.content.replace(/export /g, '') + '\nf(p);', { globalThis: {}, p: { sendMessage: (x) => out.push(x) } });
        const js = JSON.stringify(out[0]);
        check('join("§7 or §f") 拼接的列表：分隔词 or 登记，运行时逐项翻译', [...cj.entries.values()].some(e => e.value === 'or') && (js.match(/"translate"/g) || []).length === 4, js);
    }
    {
        const ck = new NS.ExtractContext({});
        NS.processScript('export function f(p,id,ns){ const a=`potion.${id}.splash.name`; const b=`item.${ns}:${id}.name`; const c=`textures/items/${id}`; const d=`${ns}:${id}`; return [a,b,c,d,`Potion of ${id}`]; }', 'scripts/potions.js', ck, {});
        const kv = [...ck.entries.values()].map(e => e.value);
        check('拼出翻译键 / ID / 路径的模板（potion.${id}.splash.name）不提取', kv.length === 1 && kv[0] === 'Potion of %1$s');
    }
    {
        // 多个附加包放在一起：每个包的文字写进自己的资源包
        const files = new Map();
        for (const [n, b] of readDir(path.join(__dirname, 'fixture'))) files.set('Fixture/' + n, b);
        const man = (name, uuid, type, deps) => Buffer.from(JSON.stringify({ format_version: 2, header: { name, uuid, version: [1, 0, 0], min_engine_version: [1, 20, 0] }, modules: [{ type, uuid: uuid.replace(/^./, 'f'), version: [1, 0, 0], entry: 'scripts/main.js' }], dependencies: deps }));
        files.set('Other [BP]/manifest.json', man('Other BP', 'a0000000-0000-4000-8000-000000000001', 'script', [{ uuid: 'a0000000-0000-4000-8000-000000000002', version: [1, 0, 0] }]));
        files.set('Other [BP]/scripts/main.js', Buffer.from('import { world } from "@minecraft/server"; world.sendMessage("Hello from the other pack!");'));
        files.set('Other [RP]/manifest.json', man('Other RP', 'a0000000-0000-4000-8000-000000000002', 'resources'));
        files.set('Lone_BP/manifest.json', man('Lone', 'b0000000-0000-4000-8000-000000000001', 'script'));
        files.set('Lone_BP/scripts/main.js', Buffer.from('import { world } from "@minecraft/server"; world.sendMessage("Lonely message here!");'));
        const mm = new MemFS(files);
        await NS.runPipeline(mm, { baseName: 'mix' }, () => {});
        const vals = (p) => mm.files.has(p) ? [...NS.parseLang(mm.files.get(p).toString()).values()] : [];
        const fx = vals('Fixture/RP/texts/en_US.lang'), ot = vals('Other [RP]/texts/en_US.lang');
        const lone = [...mm.files.keys()].find(p => /Lone_BP_texts_RP\/texts\/en_US\.lang$/.test(p));
        const lv = lone ? vals(lone) : [];
        check('多个附加包：各自的文字写进各自的资源包，不混在一起',
            ot.includes('Hello from the other pack!') && !fx.includes('Hello from the other pack!') && !ot.includes('Lonely message here!')
            && lv.includes('Lonely message here!') && !fx.includes('Lonely message here!') && fx.length > 10 && ot.length < 5);
    }
    {
        // 附加包里的 .mcstructure：需人工翻译的条目可用翻译表导入并写回
        const sm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const res = await NS.runPipeline(sm, { baseName: 'fixture' }, () => {});
        const ss = res.manualSession;
        const csv = res.workbook['untranslatable.csv'];
        const rows = NS.worldParseCsv(csv.replace(/^\ufeff/, ''));
        const h = rows[0];
        const sRows = rows.slice(1).filter(r => r[h.indexOf('ref')]);
        for (const r of sRows) r[h.indexOf('translation')] = '已翻译：' + r[h.indexOf('text')];
        const imp = ss ? ss.importCsv(rows.map(r => r.map(x => /[",\n;]/.test(x) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',')).join('\n')) : { applied: 0 };
        const ap = ss ? await ss.applyTo(sm) : { structures: 0 };
        const n = ap.structures;
        const st = await NS.openStructure('village.mcstructure', sm.files.get('BP/structures/village.mcstructure'), {}, () => {});
        const hits = st.search('已翻译：');
        const fileRows = sRows.filter(r => r[h.indexOf('ref')].startsWith('F|'));
        const fileOk = fileRows.every(r => { const f = sm.files.get(r[h.indexOf('file')]); return f && f.toString().includes('已翻译：'); });
        check('附加包：文件里的需人工翻译（set_name / nameTag / setLore…）也能导入翻译表写回', fileRows.length >= 3 && ap.files >= 2 && ap.missed === 0 && fileOk, JSON.stringify({ fileRows: fileRows.length, ap }));
        const srows = sRows.filter(r => !r[h.indexOf('ref')].startsWith('F|'));
        sRows.length = 0; sRows.push(...srows);
        check('附加包内结构：翻译表带 ref，可导入并写回 .mcstructure', !!ss && sRows.length > 0 && h.includes('translation') && imp.applied >= sRows.length && n === 1 && hits.length >= sRows.length, JSON.stringify({ rows: sRows.length, imp, n, hits: hits.length }));
    }
    {
        // 只有结构的单个 .mcpack（包在根目录，转换时移入子文件夹）：手动修改写回移动后的位置
        const files = new Map();
        files.set('manifest.json', Buffer.from(JSON.stringify({ format_version: 2, header: { name: 'MyStructures', uuid: 'c0000000-0000-4000-8000-000000000001', version: [1, 0, 0], min_engine_version: [1, 20, 0] }, modules: [{ type: 'data', uuid: 'c0000000-0000-4000-8000-000000000002', version: [1, 0, 0] }] })));
        files.set('structures/village.mcstructure', readDir(path.join(__dirname, 'fixture')).get('BP/structures/village.mcstructure'));
        const rm = new MemFS(files);
        const rr = await NS.runPipeline(rm, { baseName: 'sp' }, () => {});
        const ss = rr.structureSession;
        if (ss) ss.setValue(ss.ctx.untranslatable[0].ref, '根目录改名');
        const n = ss ? ss.applyTo(rm) : 0;
        const moved = rm.files.get('sp_BP/structures/village.mcstructure');
        const st = moved && await NS.openStructure('v.mcstructure', moved, {}, () => {});
        check('根目录结构包：移入子文件夹后，手动修改写回新位置（不在根目录多出文件）', n === 1 && !rm.files.has('structures/village.mcstructure') && st && st.search('根目录改名').length === 1);
    }
    {
        // 把已经转换过的附加包再转换一次：脚本不能重复注入，不应产生新键
        const rm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        await NS.runPipeline(rm, { baseName: 'fixture' }, () => {});
        const snap = new Map([...rm.files].map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
        const r2 = await NS.runPipeline(rm, { baseName: 'fixture' }, () => {});
        const changed = [...rm.files].filter(([k, v]) => snap.get(k) !== Buffer.from(v).toString('base64'));
        check('再次转换已转换的附加包：脚本跳过、不产生新键、文件不变', r2.ctx.entries.size === 0 && changed.length === 0 && r2.ctx.warnings.some(w => /已经转换过/.test(w)) && (rm.files.get('BP/scripts/main.js').toString().match(/end i18n runtime/g) || []).length === 1);
    }
    {
        const lv = 'tellraw @a {"rawtext": [{"selector":"@s"}, {"text":"§cWarning: §bBoth Levers were detected being used, the map may or may not have broken due to this. If the map fails to function, restart with a new copy."}]}';
        const cl = new NS.ExtractContext({});
        check('英文里的 function / return 不当成代码（“fails to function”、“[Info] … [x]”）', NS.translateCommand(lv, cl, 'k', 'f').changed && NS.looksLikeText('Press to return to the lobby.') && NS.looksLikeText('[Info] Welcome back [VIP]')
            && !NS.looksLikeText('function f() { return 1 }') && !NS.looksLikeText('{"a":1}') && !NS.looksLikeText('x => x + 1'));
    }
    {
        // 存档再次转换：之前生成的翻译资源包保留（含已填译文），新键追加，不重复登记
        const wm = new MemFS(readDir(path.join(__dirname, 'world-fixture')));
        await NS.runWorldPipeline(wm, { sayMode: 'keep' }, () => {});
        const packZh = [...wm.files.keys()].find(p => /resource_packs\/[^/]+_texts\/texts\/zh_CN\.lang$/.test(p));
        const zh0 = NS.parseLang(wm.files.get(packZh).toString());
        const k0 = [...zh0.keys()].find(k => k.startsWith('world.'));
        wm.files.set(packZh, Buffer.from(wm.files.get(packZh).toString().replace(new RegExp('^' + k0.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*$', 'm'), k0 + '=【已翻译】')));
        const r2 = await NS.runWorldPipeline(wm, { sayMode: 'tellraw' }, () => {});
        const zh1 = NS.parseLang(wm.files.get(packZh).toString());
        const packs = [...wm.files.keys()].filter(p => /resource_packs\/[^/]+\/manifest\.json$/.test(p));
        const wrp = JSON.parse(wm.files.get([...wm.files.keys()].find(p => p.endsWith('world_resource_packs.json'))).toString());
        check('存档再次转换：已有翻译资源包保留译文，新键追加，不重复登记', zh1.get(k0) === '【已翻译】' && r2.ctx.entries.size > 0 && [...r2.ctx.entries.keys()].every(k => zh1.has(k) && !zh0.has(k)) && packs.length === 1 && wrp.length === new Set(wrp.map(p => p.pack_id)).size);
    }
    {
        // 存档自带的行为包 / 资源包：对话、脚本等按附加包流程提取；无资源包的行为包在 resource_packs/ 新建并登记
        const files = new Map(readDir(path.join(__dirname, 'world-fixture')));
        for (const [n, b] of readDir(path.join(__dirname, 'fixture'))) {
            if (n.startsWith('BP/')) files.set('behavior_packs/Fx_BP/' + n.slice(3), b);
            else if (n.startsWith('RP/')) files.set('resource_packs/Fx_RP/' + n.slice(3), b);
        }
        files.set('behavior_packs/Lone/manifest.json', Buffer.from(JSON.stringify({ format_version: 2, header: { name: 'Lone', uuid: 'd0000000-0000-4000-8000-000000000001', version: [1, 0, 0], min_engine_version: [1, 20, 0] }, modules: [{ type: 'data', uuid: 'd0000000-0000-4000-8000-000000000002', version: [1, 0, 0] }] })));
        files.set('behavior_packs/Lone/dialogue/raymond.json', Buffer.from(JSON.stringify({ format_version: '1.17', 'minecraft:npc_dialogue': { scenes: [{ scene_tag: 'raymond', npc_name: '§6Raymond', text: 'Huh? Hello', buttons: [{ name: 'Who are you?', commands: [] }] }] } })));
        const em = new MemFS(files);
        const er = await NS.runWorldPipeline(em, {}, () => {});
        const prefix = [...em.files.keys()].find(k => k.endsWith('behavior_packs/Lone/manifest.json')).replace('behavior_packs/Lone/manifest.json', '');
        const dlg = em.files.get(prefix + 'behavior_packs/Lone/dialogue/raymond.json').toString();
        const loneLang = em.files.get(prefix + 'resource_packs/Lone_texts/texts/en_US.lang');
        const wrp = JSON.parse(em.files.get(prefix + 'world_resource_packs.json').toString());
        const loneUuid = JSON.parse(em.files.get(prefix + 'resource_packs/Lone_texts/manifest.json').toString()).header.uuid;
        check('存档自带的包：对话按附加包流程转换，新资源包放进 resource_packs/ 并登记；同名 BP/RP 正确配对',
            /"translate"/.test(dlg) && loneLang && /Huh\? Hello/.test(loneLang.toString()) && wrp.some(p => p.pack_id === loneUuid)
            && !em.files.has(prefix + 'resource_packs/Fx_BP_texts/manifest.json') && 'packs_strings.csv' in er.workbook);
    }
    {
        // 自定义 NPC 实体（low:npc）：按 NPC 数据字段识别
        const { T, NbtString, writeAll } = NS.NBT;
        const S = (n, v) => ({ t: T.STRING, n, v: new NbtString(v, null) });
        const L = (n, et, items) => ({ t: T.LIST, n, v: { et, items } });
        const C = (n, v) => ({ t: T.COMPOUND, n, v });
        const npc = [S('identifier', 'low:npc'), S('CustomName', 'NPC'), S('RawtextName', '§6Raymond'), S('InterativeText', 'Huh? Hello'), L('Pos', T.FLOAT, [0.5, 1, 0.5]), { t: T.LONG, n: 'UniqueID', v: -7n }];
        const root = [{ t: T.INT, n: 'format_version', v: 1 }, L('size', T.INT, [1, 1, 1]), C('structure', [L('block_indices', T.LIST, [{ et: T.INT, items: [-1] }, { et: T.INT, items: [-1] }]), L('entities', T.COMPOUND, [npc]), C('palette', [C('default', [L('block_palette', T.COMPOUND, []), C('block_position_data', [])])])]), L('structure_world_origin', T.INT, [0, 0, 0])];
        const st = await NS.openStructure('bro.mcstructure', writeAll([{ t: T.COMPOUND, n: '', v: root }]), {}, () => {});
        const vals = [...st.ctx.entries.values()].map(e => e.value);
        check('自定义 NPC 实体（low:npc）的对话和名字也提取，CustomName 不误报', vals.includes('Huh? Hello') && vals.includes('Raymond') && !st.ctx.untranslatable.some(u => u.text === 'NPC'), JSON.stringify(vals));
    }
    {
        // 展示框 / 荧光展示框里的物品、掉落物、营火上的物品
        const { T, NbtString, writeAll } = NS.NBT;
        const S = (n, v) => ({ t: T.STRING, n, v: new NbtString(v, null) });
        const I = (n, v) => ({ t: T.INT, n, v });
        const B = (n, v) => ({ t: T.BYTE, n, v });
        const L = (n, et, items) => ({ t: T.LIST, n, v: { et, items } });
        const C = (n, v) => ({ t: T.COMPOUND, n, v });
        const named = (n, id, name, lore) => C(n, [B('Count', 1), S('Name', id), C('tag', [C('display', [S('Name', name), L('Lore', T.STRING, [new NbtString(lore, null)])])])]);
        const frame = [S('id', 'ItemFrame'), I('x', 0), I('y', 0), I('z', 0), named('Item', 'minecraft:diamond_sword', 'Frame Sword', 'Hung on the wall')];
        const glow = [S('id', 'GlowItemFrame'), I('x', 1), I('y', 0), I('z', 0), named('Item', 'minecraft:apple', 'Glow Apple', 'Shiny fruit')];
        const camp = [S('id', 'Campfire'), I('x', 2), I('y', 0), I('z', 0), named('Item1', 'minecraft:beef', 'Camp Beef', 'Slowly cooking')];
        const drop = [S('identifier', 'minecraft:item'), named('Item', 'minecraft:book', 'Dropped Book', 'Lying on the ground'), L('Pos', T.FLOAT, [0.5, 1, 0.5]), { t: T.LONG, n: 'UniqueID', v: -9n }];
        const st0 = (name) => [S('name', name), C('states', []), I('version', 18168865)];
        const root = [I('format_version', 1), L('size', T.INT, [3, 1, 1]), C('structure', [L('block_indices', T.LIST, [{ et: T.INT, items: [0, 1, 2] }, { et: T.INT, items: [-1, -1, -1] }]), L('entities', T.COMPOUND, [drop]),
            C('palette', [C('default', [L('block_palette', T.COMPOUND, [st0('minecraft:frame'), st0('minecraft:glow_frame'), st0('minecraft:campfire')]),
                C('block_position_data', [C('0', [C('block_entity_data', frame)]), C('1', [C('block_entity_data', glow)]), C('2', [C('block_entity_data', camp)])])])])]), L('structure_world_origin', T.INT, [0, 0, 0])];
        const st = await NS.openStructure('frames.mcstructure', writeAll([{ t: T.COMPOUND, n: '', v: root }]), {}, () => {});
        const un = st.ctx.untranslatable.map(u => u.text);
        check('展示框 / 荧光展示框 / 营火上的物品、掉落物的名称和描述列入需人工翻译',
            ['Frame Sword', 'Hung on the wall', 'Glow Apple', 'Shiny fruit', 'Camp Beef', 'Dropped Book', 'Lying on the ground'].every(t => un.includes(t)), JSON.stringify(un));
        const ref = st.ctx.untranslatable.find(u => u.text === 'Glow Apple').ref;
        st.setValue(ref, '发光苹果');
        const built = await st.build();
        const st2 = await NS.openStructure('frames.mcstructure', built.structure, {}, () => {});
        check('  └ 手动修改后写回展示框物品', st2.ctx.untranslatable.some(u => u.text === '发光苹果') && !st2.ctx.untranslatable.some(u => u.text === 'Glow Apple'));
    }
    {
        // Myths and Magic：手写 rawtext 里 { text: 变量 }（聊天消息做的弹出提示）
        const src = 'const spells=[{id:"a",lore:"Summon a wall of fire."}];\nfunction getLore(id){ return spells.find(s=>s.id===id).lore; }\nfunction notify(player, message, image){ player.sendMessage({ rawtext: [ { text: `toast.${image}` }, { text: message } ] }); }\nexport function f(p){ notify(p, `§dNew Recipe\\n§r${getLore("a")}`, "textures/ui/x"); }';
        const cm = new NS.ExtractContext({ splitNewlines: false });
        const r = NS.processScript(src, 'scripts/main.js', cm, { injectRuntime: true });
        const out = [];
        require('vm').runInNewContext(r.content.replace(/export /g, '') + '\nf(p);', { globalThis: {}, p: { sendMessage: (x) => out.push(x) } });
        const js = JSON.stringify(out[0]);
        check('手写 rawtext 里的 { text: 变量 } 运行时翻译（New Recipe 提示）', (js.match(/"translate"/g) || []).length === 2 && js.includes('toast.textures/ui/x'), js);

        // 创造栏隐藏的物品不生成占位名
        const hm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const mk = (id, cat) => Buffer.from(JSON.stringify({ format_version: '1.20.80', 'minecraft:item': { description: { identifier: id, menu_category: cat }, components: { 'minecraft:icon': 'x' } } }));
        hm.files.set('BP/items/hidden_icon.json', mk('tianji:hidden_icon', { category: 'none' }));
        hm.files.set('BP/items/shown_thing.json', mk('tianji:shown_thing', { category: 'items' }));
        const hr = await NS.runPipeline(hm, { baseName: 'fixture' }, () => {});
        check('创造物品栏隐藏的物品（category: none）不生成占位名', !hr.ctx.entries.has('item.tianji:hidden_icon.name') && hr.ctx.entries.has('item.tianji:shown_thing.name'));
        const cr2 = new NS.ExtractContext({});
        cr2.report('f', 'set_name', 'PONDERING_BOOK_tether', 'x'); cr2.report('f', 'set_name', 'Pondering Book', 'x');
        check('带下划线的标识符（PONDERING_BOOK_tether）不列入报告', cr2.untranslatable.length === 1);
    }
    {
        // 存档：作者已写成 rawtext 的物品描述不列入需人工翻译；自带资源包里已有的键不再提取
        const { T, NbtString, writeAll } = NS.NBT;
        const S = (n, v) => ({ t: T.STRING, n, v: new NbtString(v, null) });
        const L = (n, et, items) => ({ t: T.LIST, n, v: { et, items } });
        const C = (n, v) => ({ t: T.COMPOUND, n, v });
        const chest = [S('id', 'Chest'), { t: T.INT, n: 'x', v: 0 }, { t: T.INT, n: 'y', v: 0 }, { t: T.INT, n: 'z', v: 0 },
            L('Items', T.COMPOUND, [[{ t: T.BYTE, n: 'Count', v: 1 }, S('Name', 'mm:ancient_texts'), { t: T.BYTE, n: 'Slot', v: 0 }, C('tag', [C('display', [L('Lore', T.STRING, [new NbtString('{"rawtext":[{"translate":"desc.ancient_texts"}]}', null), new NbtString('Plain old lore', null)])])])]])];
        const root = [{ t: T.INT, n: 'format_version', v: 1 }, L('size', T.INT, [1, 1, 1]), C('structure', [L('block_indices', T.LIST, [{ et: T.INT, items: [0] }, { et: T.INT, items: [-1] }]), L('entities', T.COMPOUND, []), C('palette', [C('default', [L('block_palette', T.COMPOUND, [[S('name', 'minecraft:chest'), C('states', []), { t: T.INT, n: 'version', v: 1 }]]), C('block_position_data', [C('0', [C('block_entity_data', chest)])])])])]), L('structure_world_origin', T.INT, [0, 0, 0])];
        const st = await NS.openStructure('b.mcstructure', writeAll([{ t: T.COMPOUND, n: '', v: root }]), {}, () => {});
        const texts = st.ctx.untranslatable.map(u => u.text);
        const ku = st.ctx.untranslatable.find(u => /rawtext/.test(u.text));
        check('存档 / 结构：作者写成翻译键的物品描述仍列入（游戏实测不支持），并说明原因', texts.includes('Plain old lore') && ku && /不支持/.test(ku.reason), JSON.stringify(texts));
    }
    {
        const ca = new NS.ExtractContext({});
        NS.processScript('export function f(p,id,v){ p.sendMessage(`@attributes.${id}.name: ${v}%%`); p.sendMessage(`Mana boost: ${v}%`); }', 'scripts/magicOrbStand.js', ca, {});
        const va = [...ca.entries.values()].map(e => e.value);
        check('拼出键引用的模板（@attributes.${id}.name: ${v}%）不提取', !va.some(v => /@attributes/.test(v)) && va.some(v => /Mana boost/.test(v)), JSON.stringify(va));
    }
    {
        // RPG：content/langs/en.js / ru.js 各导出一个字典，同路径共用键；%1$s 句式
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const dict = (o) => Buffer.from('export { Dictionary };\nconst Dictionary = ' + JSON.stringify(o, null, 2) + ';\n');
        xm.files.set('BP/scripts/langs/en.js', dict({ goods: { apple: 'Apple', axo: 'Adult %1$s Axolotl', blue: 'Blue', bread: 'Bread', bow: 'Bow' }, ui: { open: 'Open the menu' } }));
        xm.files.set('BP/scripts/langs/ru.js', dict({ goods: { apple: 'Яблоко', axo: '%1$s взрослого аксолотля', blue: 'Синий', bread: 'Хлеб', bow: 'Лук' }, ui: { open: 'Открыть меню' } }));
        xm.files.set('BP/scripts/langs/uk.js', dict({ goods: { apple: 'Яблуко', axo: 'Доросла %1$s аксолотль', blue: 'Синя', bread: 'Хліб', bow: 'Лук' }, ui: { open: 'Відкрити меню' } }));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture' }, () => {});
        const en = NS.parseLang(xm.files.get('RP/texts/en_US.lang').toString());
        const ru = NS.parseLang(xm.files.get('RP/texts/ru_RU.lang').toString());
        const uk = xm.files.get('RP/texts/uk_UA.lang') && NS.parseLang(xm.files.get('RP/texts/uk_UA.lang').toString());
        const k = [...en.keys()].find(x => /langs\.goods\.apple$/.test(x));
        const ka = [...en.keys()].find(x => /langs\.goods\.axo$/.test(x));
        check('按语言分文件的字典（langs/en.js、ru.js、uk.js）：同路径共用一个键，各语言写进各自 lang', k && en.get(k) === 'Apple' && ru.get(k) === 'Яблоко' && uk && uk.get(k) === 'Яблуко' && en.get(ka) === 'Adult %1$s Axolotl' && ru.get(ka) === '%1$s взрослого аксолотля'
            && ![...xr.ctx.entries.values()].some(e => /[\u0400-\u04ff]/.test(e.value)));
    }
    {
        // RPG：字典值里的 @引用 / $变量 由作者的 translate() 解析，lang 里改成 %n$s，运行时按解析后的整句匹配
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const dict = (o) => Buffer.from('export { Dictionary };\nconst Dictionary = ' + JSON.stringify(o, null, 2) + ';\n');
        xm.files.set('BP/scripts/langs/en.js', dict({ tile: { 'sert:press': 'Press', 'sert:bowl': 'Grinding Bowl' }, common: { exp: 'Experience' }, hints: { press: 'Craft @tile.sert:press to view your skills', need: 'Not enough items (Required: $requiredAmount# )', alias: '@common.exp', both: '@tile.sert:press & @tile.sert:bowl' } }));
        xm.files.set('BP/scripts/langs/ru.js', dict({ tile: { 'sert:press': 'Пресс', 'sert:bowl': 'Ступка' }, common: { exp: 'Опыт' }, hints: { press: 'Создайте @tile.sert:press, чтобы увидеть навыки', need: 'Недостаточно предметов (нужно: $requiredAmount# )', alias: '@common.exp', both: '@tile.sert:press & @tile.sert:bowl' } }));
        xm.files.set('BP/scripts/xp.js', Buffer.from('import { world } from "@minecraft/server";\nimport { translate } from "./t.js";\nexport function show(p, a, b) { p.sendMessage(translate("@common.exp: §g" + a + "/" + b, p)); p.sendMessage(translate("/give @s apple", p)); }\n'));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture' }, () => {});
        const en = NS.parseLang(xm.files.get('RP/texts/en_US.lang').toString());
        const ru = NS.parseLang(xm.files.get('RP/texts/ru_RU.lang').toString());
        const kp = [...en.keys()].find(x => /langs\.hints\.press$/.test(x)), kn = [...en.keys()].find(x => /langs\.hints\.need$/.test(x));
        const vals = [...xr.ctx.entries.values()].map(e => e.value);
        check('字典 @引用 / $变量：lang 里改成 %n$s，各语言对应；纯引用条目不提取；代码里的 "@common.exp: " 也当占位',
            en.get(kp) === 'Craft %1$s to view your skills' && ru.get(kp) === 'Создайте %1$s, чтобы увидеть навыки' && en.get(kn) === 'Not enough items (Required: %1$s)'
            && ![...en.keys()].some(x => /hints\.(alias|both)$/.test(x)) && !vals.some(v => /@/.test(v)) && vals.includes('%1$s: §g%2$s/%3$s'), JSON.stringify(vals.filter(v => /%|@/.test(v))));
    }
    {
        // RPG：作者把字典也导出到了资源包 lang（同路径键、或 entity.<id>.name 这类游戏命名）→ 直接沿用，不新建重复键
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const dict = (o) => Buffer.from('export { Dictionary };\nconst Dictionary = ' + JSON.stringify(o, null, 2) + ';\n');
        xm.files.set('BP/scripts/langs/en.js', dict({ achievements: { wood: { name: 'Chop some wood' } }, mobs: { 'sert:bear': 'Brown Bear' }, tile: { 'sert:press': 'Press' }, ui: { open: 'Open the menu', close: 'Close the menu', back: 'Go back' } }));
        xm.files.set('BP/scripts/langs/ru.js', dict({ achievements: { wood: { name: 'Добыть дерево' } }, mobs: { 'sert:bear': 'Бурый медведь' }, tile: { 'sert:press': 'Пресс' }, ui: { open: 'Открыть меню', close: 'Закрыть меню', back: 'Назад' } }));
        const en0 = (xm.files.get('RP/texts/en_US.lang') || '').toString();
        xm.files.set('RP/texts/en_US.lang', Buffer.from(en0 + '\nachievements.wood.name=Chop some wood\nentity.sert:bear.name=Brown Bear\ntile.sert:press.name=Press\n'));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture' }, () => {});
        const ks = [...xr.ctx.entries.keys()];
        const en = NS.parseLang(xm.files.get('RP/texts/en_US.lang').toString());
        check('字典条目与资源包 lang 已有键（同路径 / entity.<id>.name / tile.<id>.name）同内容时沿用，不新建重复键',
            !ks.some(k => /achievements\.wood|sert:bear|sert:press/.test(k)) && ks.some(k => /langs\.ui\.open$/.test(k)) && ![...en.keys()].some(k => /^script\..*(achievements\.wood|sert:bear|sert:press)/.test(k)), JSON.stringify(ks));
    }
    {
        // 原版物品 / 生物名：改用游戏自带的翻译键（英文一致才用）
        const V = NS.vanillaKeyFor;
        check('原版名称对照：ID / 旧式写法 → 游戏自带键，英文不一致不替换',
            V('minecraft:iron_sword', 'item', 'Iron Sword') === 'item.iron_sword.name' && V('appleEnchanted', 'item', 'Enchanted Golden Apple') === 'item.appleEnchanted.name'
            && V('minecraft:zombie', 'entity', 'Zombie') === 'entity.zombie.name' && V('minecraft:iron_sword', 'item', 'Super Sword') === null && V('sert:press', 'item', 'Press') === null);
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const dict = (o) => Buffer.from('export { Dictionary };\nconst Dictionary = ' + JSON.stringify(o, null, 2) + ';\n');
        xm.files.set('BP/scripts/langs/en.js', dict({ items: { 'minecraft:apple': 'Apple', 'minecraft:iron_sword': 'Old Blade' }, mobs: { 'minecraft:zombie': 'Zombie' }, ui: { open: 'Open the menu', close: 'Close the menu', back: 'Go back' } }));
        xm.files.set('BP/scripts/langs/ru.js', dict({ items: { 'minecraft:apple': 'Яблоко', 'minecraft:iron_sword': 'Старый клинок' }, mobs: { 'minecraft:zombie': 'Зомби' }, ui: { open: 'Открыть меню', close: 'Закрыть меню', back: 'Назад' } }));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture' }, () => {});
        const ks = [...xr.ctx.entries.keys()];
        const reg = [...xm.files.entries()].filter(([p2]) => /langs\/en\.js$/.test(p2)).map(([, b]) => b.toString()).join('');
        check('  └ 字典里的原版名称不新建键，运行时映射到 item.apple.name / entity.zombie.name；改过名的照常提取',
            !ks.some(k => /minecraft:(apple|zombie)/.test(k)) && ks.some(k => /minecraft:iron_sword/.test(k)) && /"item\.apple\.name"/.test(reg) && /"entity\.zombie\.name"/.test(reg));
    }
    {
        // Bedrock Reimagined：om(id) 把 ID 拼成英文名（"minecraft:iron_sword" → "Iron Sword"），运行时按 ID 映射翻译键
        const src = 'import { world } from "@minecraft/server";\nfunction om(e){return(e.split(":").pop()??e).split("_").filter(Boolean).map(a=>a.charAt(0).toUpperCase()+a.slice(1)).join(" ")}\nconst nm = (id) => id.replace("x:", "").split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");\nexport function f(p, id) { p.sendMessage(`Added ${om(id)} to the filter.`); p.sendMessage(nm(id)); }\n';
        const ch = new NS.ExtractContext({});
        const out = NS.processScript(src, 'scripts/h.js', ch, { injectRuntime: true, runtimeKey: '__ADDON_I18N_h', idKeys: () => new Map([['x:ruby_gem', 'item.x:ruby_gem.name']]) }).content;
        const rt = new Function(out.slice(0, out.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '') + '\nreturn __i18n;')();
        const body = out.slice(out.indexOf('// ---- end i18n runtime ----'));
        const nameOf = new Function('__i18n', body.split('\n').find(l => l.startsWith('function om')) + '\nreturn om;')(rt);
        const n1 = nameOf('minecraft:iron_sword');
        rt.H('x:ruby_gem', 'Ruby Gem');
        check('把 ID 拼成英文名的函数：返回值套 H(id, …)，运行时原版 ID → 游戏自带键、自定义 ID → 包里的键',
            n1 === 'Iron Sword' && JSON.stringify(rt.M('Iron Sword')) === '{"rawtext":[{"translate":"item.iron_sword.name"}]}' && /"translate":"item\.x:ruby_gem\.name"/.test(JSON.stringify(rt.M('Ruby Gem')))
            && (out.match(/__i18n\.H\(/g) || []).length === 2 && /return __i18n\.H\(e,/.test(out));
        check('  └ 运行时升级时保留 regIds 登记', NS.upgradeRuntime(out.replace(', FUZZY_MAX = 600', '')).includes('__i18n.regIds('));
    }
    {
        // RPG：作者自己的 ActionFormData 包装类（本地导入），内部拼字符串再调原生表单 → 只在原生调用处翻译，避免 [object Object]
        const ui = 'import * as uiDef from "@minecraft/server-ui";\nexport class ActionFormData {\n  constructor() { this.#form = new uiDef.ActionFormData(); }\n  #form\n  title(text) { this.#form.title("§r" + text + "§c§u§s§f§o§r§m"); return this; }\n  body(text) { this.#form.body(text); return this; }\n  button(text, icon) { this.#form.button("§p§a§s§s§r" + text, icon); return this; }\n}\n';
        const use = 'import { ActionFormData } from "./ui.js";\nimport * as f from "./functions.js";\nexport function open(p) { const menu = new ActionFormData(); menu.title(f.translate("@quest.title", p)); menu.body("Choose the category you like"); menu.button("Back to the menu"); }\n';
        const nat = 'import { ActionFormData } from "@minecraft/server-ui";\nexport function w(p) { const menu = new ActionFormData().title("Welcome to the addon"); menu.body("Thank you for downloading"); menu.button("Already played"); }\n';
        const cw = new NS.ExtractContext({});
        const oUi = NS.processScript(ui, 'scripts/ui.js', cw, { injectRuntime: true, collidingMethods: new Set(['title', 'body', 'button']) }).content;
        const oUse = NS.processScript(use, 'scripts/use.js', cw, { injectRuntime: true, collidingMethods: new Set(['title', 'body', 'button']) }).content;
        const oNat = NS.processScript(nat, 'scripts/nat.js', cw, { injectRuntime: true, runtimeKey: '__ADDON_I18N_wrap', collidingMethods: new Set(['title', 'body', 'button']) }).content;
        check('作者的同名表单包装类：调用处不包 M（避免 [object Object]），包装类内部的原生 this.#form 调用照常翻译',
            /this\.#form\.title\(\{"rawtext"|this\.#form\.title\(__i18n/.test(oUi) && /this\.#form\.body\(__i18n\.M/.test(oUi) && /this\.#form\.button\(\{"rawtext"|this\.#form\.button\(__i18n/.test(oUi)
            && !/menu\.(title|body|button)\(__i18n/.test(oUse) && /menu\.body\(\{"rawtext"|menu\.body\(__i18n/.test(oNat) && /menu\.button\(\{"rawtext"|menu\.button\(__i18n/.test(oNat), oUse + '\n' + oNat);
        // 运行时：作者按宽度自动换行、多条动作栏用 "§r\n" 拼在一起
        const rt = new Function(oNat.slice(0, oNat.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '') + '\nreturn __i18n;')();
        rt.reg([['To select bait, take it in your hand and click on a block. Then select the desired fishing rod', 'k.bait'], ['I am new here', 'k.new']], []);
        const wrapped = 'To select bait, take it in your hand and click on a block. Then select the\ndesired fishing rod';
        check('运行时：自动换行过的文字还原换行再匹配；"§r\\n" 分隔的多条逐条翻译', JSON.stringify(rt.M(wrapped)) === '{"rawtext":[{"translate":"k.bait"}]}'
            && JSON.stringify(rt.M(wrapped + '§r\nI am new here')) === '{"rawtext":[{"translate":"k.bait"},{"text":"§r\\n"},{"translate":"k.new"}]}');
    }
    {
        // RPG 第二轮：两个类都有 #form（一个原生、一个作者包装类）；setLore 在 2.2.0+ 可用 RawMessage；运行时排版 / 颜色 / 句点
        const ui = 'import * as uiDef from "@minecraft/server-ui";\nclass Base { constructor() { this.#form = new uiDef.ActionFormData(); } #form\n  button(t) { this.#form.button("§r" + t); } }\nexport class ActionFormData { constructor() { this.#form = new Base(); } #form\n  button(t) { this.#form.button(t); return this; } }\nexport function lore(item, lines) { item.setLore(lines); item.setLore(["Sharp blade of the north"]); }\n';
        const cx = new NS.ExtractContext({});
        const o1 = NS.processScript(ui, 'scripts/ui.js', cx, { injectRuntime: true, runtimeKey: '__ADDON_I18N_r2', rawLore: true, collidingMethods: new Set(['button']) }).content;
        const o2 = NS.processScript(ui, 'scripts/ui2.js', new NS.ExtractContext({}), { injectRuntime: true, runtimeKey: '__ADDON_I18N_r2b', collidingMethods: new Set(['button']) }).content;
        check('同名私有字段 #form 按类区分：只有原生表单那个类的调用翻译；setLore 在 2.2.0+ 走 RawMessage，旧版本仍列入无法本地化',
            /class Base[^]*this\.#form\.button\(\{"rawtext"|class Base[^]*this\.#form\.button\(__i18n/.test(o1) && /return this; \}/.test(o1) && /class ActionFormData[^}]*\{[^}]*\}[^]*button\(t\) \{ this\.#form\.button\(t\); return this;/.test(o1)
            && /setLore\(__i18n\.MA\(lines\)\)/.test(o1) && /setLore\(\[\{"rawtext"/.test(o1) && !/setLore\(__i18n/.test(o2));
        const rt = new Function(o1.slice(0, o1.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '') + '\nreturn __i18n;')();
        rt.reg([['Guidebook To Magic', 'k.g'], ['§eMagic connector', 'k.c']], [['k.d', ['You will receive: ', ''], null]]);
        const body = 'textures/ui/bar.png'.padEnd(100, '\t') + '0/14'.padEnd(100, '\t') + 'You will receive: Guidebook To Magic, §eMagic connector';
        const r = JSON.stringify(rt.M(body));
        check('运行时：制表符排版的正文只翻最后一段；列表里被分隔符吃掉的颜色码补回再找',
            r.startsWith('{"rawtext":[{"text":"textures/ui/bar.png\\t') && /"translate":"k\.d"/.test(r) && /"translate":"k\.g"/.test(r) && /\{"text":", "\},\{"translate":"k\.c"\}/.test(r), r.slice(-300));
    }
    {
        // 包里原有、目标语言还没有译文的键（item.sert:hogweed）也要进翻译表；"A & B" 按列表逐项翻译
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const en0 = (xm.files.get('RP/texts/en_US.lang') || '').toString();
        xm.files.set('RP/texts/en_US.lang', Buffer.from(en0 + '\nitem.sert:hogweed=Hogweed\n'));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture', targetLangs: ['en_US', 'zh_CN'] }, () => {});
        const csv = String(xr.workbook['strings.csv']), src = String(Object.entries(xr.workbook).find(([n]) => /^source_/.test(n))[1]);
        check('翻译表包含包里原有、目标语言还没有译文的键', /item\.sert:hogweed,Hogweed,[^,]*,existing/.test(csv) && /item\.sert:hogweed=Hogweed/.test(src));
        const cl = new NS.ExtractContext({});
        const o = NS.processScript('import { world } from "@minecraft/server";\nexport function f(p, a) { p.sendMessage(a); }\n', 'scripts/amp.js', cl, { injectRuntime: true, runtimeKey: '__ADDON_I18N_amp' }).content;
        const rt = new Function(o.slice(0, o.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '') + '\nreturn __i18n;')();
        rt.reg([['Press', 'k.p'], ['Grinding Bowl', 'k.g']], []);
        check('运行时：“A & B” 两项都认识时逐项翻译', JSON.stringify(rt.M('Press & Grinding Bowl')) === '{"rawtext":[{"translate":"k.p"},{"text":" & "},{"translate":"k.g"}]}' && rt.M('Tom & Jerry') === 'Tom & Jerry');
    }
    {
        // 方块藏在创造栏，但有可见物品通过 block_placer + replace_block_item 代替它出现（RPG 的 sert:pink_lotus_waterlily）
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        xm.files.set('BP/blocks/lily.json', Buffer.from(JSON.stringify({ format_version: '1.21.90', 'minecraft:block': { description: { identifier: 'sert:lily', menu_category: { category: 'none' } }, components: { 'minecraft:display_name': 'Lily pad with lotus' } } })));
        xm.files.set('BP/blocks/ghost.json', Buffer.from(JSON.stringify({ format_version: '1.21.90', 'minecraft:block': { description: { identifier: 'sert:ghost', menu_category: { category: 'none' } }, components: { 'minecraft:display_name': 'Ghost Block' } } })));
        xm.files.set('BP/items/lily.json', Buffer.from(JSON.stringify({ format_version: '1.21.90', 'minecraft:item': { description: { identifier: 'sert:lily_item', menu_category: { category: 'nature' } }, components: { 'minecraft:block_placer': { block: 'sert:lily', replace_block_item: true } } } })));
        const en0 = (xm.files.get('RP/texts/en_US.lang') || '').toString();
        xm.files.set('RP/texts/en_US.lang', Buffer.from(en0 + '\nitem.sert:lily_item=Lily pad\n'));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture', targetLangs: ['en_US', 'zh_CN'] }, () => {});
        const vals = [...xr.ctx.entries.values()].map(e => e.value);
        const zh = xm.files.get('RP/texts/zh_CN.lang').toString();
        check('隐藏方块有可见物品代替出现时：方块名照常提取、物品键照常补全；真正隐藏的仍跳过',
            vals.includes('Lily pad with lotus') && !vals.includes('Ghost Block') && /item\.sert:lily_item=Lily pad/.test(zh), JSON.stringify(vals.slice(-5)));
    }
    {
        const cm = new NS.ExtractContext({}); cm.sayMode = 'tellraw';
        const me = NS.translateCommand('/me waves at @p warmly', cm, 'cmd.me', 'f', { sender: { text: 'Guide' } }).cmd;
        check('/me → tellraw，保留 “* 发送者 消息” 格式', me === '/tellraw @a {"rawtext":[{"text":"* "},{"text":"Guide"},{"text":" "},{"translate":"cmd.me","with":{"rawtext":[{"selector":"@p"}]}}]}' && [...cm.entries.values()][0].value === 'waves at %1$s warmly', me);
    }
    {
        // 基岩版重塑：名称里引用了别的键（%tile.x.name、%potion.wither），只把自己的文字换成 %新键
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        xm.files.set('BP/blocks/spikes.json', Buffer.from(JSON.stringify({ format_version: '1.21.90', 'minecraft:block': { description: { identifier: '5fs_br:spikes' }, components: { 'minecraft:display_name': '%tile.5fs_br.spikes.name\n§7§c%potion.wither II (0:05)§r\n§9Bedrock Reimagined' } } })));
        xm.files.set('BP/blocks/only.json', Buffer.from(JSON.stringify({ format_version: '1.21.90', 'minecraft:block': { description: { identifier: '5fs_br:only' }, components: { 'minecraft:display_name': '%tile.5fs_br.only.name\n§7%potion.wither II' } } })));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture' }, () => {});
        const dn = JSON.parse(xm.files.get('BP/blocks/spikes.json').toString())['minecraft:block'].components['minecraft:display_name'];
        const d2 = JSON.parse(xm.files.get('BP/blocks/only.json').toString())['minecraft:block'].components['minecraft:display_name'];
        const vals = [...xr.ctx.entries.values()].map(e => e.value);
        check('名称里引用了别的 %键：引用原样保留，只把自己的文字换成 %新键；只有引用的不动',
            dn === '%tile.5fs_br.spikes.name\n§7§c%potion.wither II (0:05)§r\n§9%tile.5fs_br:spikes.name.text' && vals.includes('Bedrock Reimagined') && !vals.some(v => /%tile|%potion/.test(v)) && d2 === '%tile.5fs_br.only.name\n§7%potion.wither II', JSON.stringify(dn));
    }
    {
        // 百分号：带参数的值 % → %%、已有的 %% 不再翻倍；不带参数的值 %% → %
        const cp = new NS.ExtractContext({});
        NS.processScript('import { world } from "@minecraft/server";\nexport function f(p, a) { p.sendMessage("Full 100% safe now"); p.sendMessage("Chance: " + a + "% to win"); p.sendMessage("Rate 50%% done here"); p.sendMessage(`Bonus ${a}%% extra power`); p.sendMessage("Keep %%s as written"); }\n', 'scripts/pct.js', cp, { injectRuntime: true, runtimeKey: '__ADDON_I18N_pct' });
        const pv = [...cp.entries.values()].map(e => e.value);
        check('百分号：带参数时 %→%%、已转义的 %% 不翻倍；不带参数时 %%→%', JSON.stringify(pv) === JSON.stringify(['Full 100% safe now', 'Chance: %1$s%% to win', 'Rate 50% done here', 'Bonus %1$s%% extra power', 'Keep %%s as written']), JSON.stringify(pv));
    }
    {
        // 基岩版重塑：界面用 (#title_text = 'Magic') 判断显示哪个自定义界面；manifest 的包设置 / 子包名称
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        xm.files.set('RP/ui/server_form.json', Buffer.from(JSON.stringify({ namespace: 'server_form', panel: { type: 'panel', bindings: [{ binding_name: '#title_text' }, { binding_type: 'view', source_property_name: "((#title_text = 'Magic Quests') or (#title_text = 'The End'))", target_property_name: '#visible' }], controls: [{ lbl: { type: 'label', text: 'Magic Quests' } }, { lbl2: { type: 'label', text: 'Choose your path wisely' } }] } })));
        xm.files.set('BP/scripts/q.js', Buffer.from('import { ActionFormData } from "@minecraft/server-ui";\nexport function q(p, t) { new ActionFormData().title("Magic Quests").body("Pick a quest to start").button("The End").show(p); new ActionFormData().title(t).show(p); }\n'));
        const man = NS.parseJsonLenient(xm.files.get('RP/manifest.json').toString());
        man.settings = [{ type: 'label', text: 'Health bar settings' }, { type: 'dropdown', name: 'x:health', text: 'Show health bars', options: [{ name: 'off', text: 'Never shown' }, { name: 'on', text: 'Always shown' }], default: 'off' }, { type: 'toggle', name: 'x:keyed', text: 'br.settings.keyed', default: true }];
        man.subpacks = [{ folder_name: 'a', name: 'Custom Visuals (Default)', memory_performance_tier: 0 }];
        xm.files.set('RP/manifest.json', Buffer.from(JSON.stringify(man)));
        const xr = await NS.runPipeline(xm, { baseName: 'fixture' }, () => {});
        const ui = JSON.parse(xm.files.get('RP/ui/server_form.json').toString());
        const js = xm.files.get('BP/scripts/q.js').toString();
        const m2 = JSON.parse(xm.files.get('RP/manifest.json').toString());
        const rpEn = NS.parseLang(xm.files.get('RP/texts/en_US.lang').toString());
        check('界面里拿来比较的文字：脚本标题、按钮保持原文（界面里只显示的标签照常翻译），其他照常翻译',
            ui.panel.controls[0].lbl.text !== 'Magic Quests' && ui.panel.controls[1].lbl2.text !== 'Choose your path wisely' && /\.title\("Magic Quests"\)/.test(js) && /\.button\("The End"\)/.test(js) && /\.body\(\{"rawtext"/.test(js) && /__i18n\.keep\(\[/.test(js));
        check('manifest：包设置 text 换成本包键（选项也是），已是键的不动；子包名称列入需人工处理',
            m2.settings[0].text === 'pack.settings.0' && m2.settings[1].text === 'pack.settings.health' && m2.settings[1].options[1].text === 'pack.settings.health.on' && m2.settings[2].text === 'br.settings.keyed'
            && rpEn.get('pack.settings.health') === 'Show health bars' && xr.ctx.untranslatable.some(u => u.text === 'Custom Visuals (Default)' && /子包/.test(u.where)), JSON.stringify(m2.settings));
        const rt = new Function(js.slice(0, js.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '') + '\nreturn __i18n;')();
        rt.reg([['The End', 'k.end'], ['Some text here', 'k.s']], []);
        check('  └ 运行时 keep：比较用的文字不翻译', rt.M('The End') === 'The End' && rt.M('§lThe End§r') === '§lThe End§r' && JSON.stringify(rt.M('Some text here')) === '{"rawtext":[{"translate":"k.s"}]}');
    }
    {
        // 基岩版重塑：准星方块名（WAILA）"inspecting:" 前缀 + gy() 拼的英文名；界面悬停提示 #hover_text
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        xm.files.set('RP/ui/waila.json', Buffer.from(JSON.stringify({ namespace: 'waila', w: { type: 'label', text: '#t', bindings: [{ binding_type: 'view', source_property_name: "(#title_text - 'inspecting:')", target_property_name: '#t' }] }, lock: { 'hover@common.hover_text': { property_bag: { '#hover_text': 'Upgrade Accessory Bag to Unlock' } } } })));
        xm.files.set('BP/scripts/w.js', Buffer.from('import { world } from "@minecraft/server";\nfunction WN(w){return w.charAt(0).toUpperCase()+w.slice(1)}\nfunction gy(e){if(!e)return"";return String(e).replace(/^[^:]+:/,"").replace(/[._\\-]+/g," ").trim().split(/\\s+/).filter(Boolean).map(WN).join(" ")}\nexport function show(p, b) { p.runCommand(`titleraw @s title ${JSON.stringify({rawtext:[{text:"inspecting:§e§n§t" + gy(b) + "\\n§9§oMinecraft"}]})}`); }\n'));
        const xres = await NS.runPipeline(xm, { baseName: 'fixture' }, () => {});
        const js = xm.files.get('BP/scripts/w.js').toString();
        const ui = JSON.parse(xm.files.get('RP/ui/waila.json').toString());
        check('界面悬停提示 #hover_text 保持原文、列进需人工翻译（游戏不翻译它，写键会显示键名）', ui.lock['hover@common.hover_text'].property_bag['#hover_text'] === 'Upgrade Accessory Bag to Unlock'
            && xres.ctx.untranslatable.some(u => u.text === 'Upgrade Accessory Bag to Unlock'));
        const head = js.slice(0, js.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '');
        const rt = new Function(head + '\nreturn __i18n;')();
        const body = js.slice(js.indexOf('// ---- end i18n runtime ----'));
        const gy = new Function('__i18n', body.split('\n').filter(l => /^function (WN|gy)/.test(l)).join('\n') + '\nreturn gy;')(rt);
        const r = JSON.stringify(rt.T('inspecting:§e§n§t' + gy('minecraft:allium')));
        check('拼英文名的函数（replace(/[._-]+/g," ") + map(WN)）也套 H；"inspecting:" 前缀保留、后面的名字翻译成游戏键', /__i18n\.H\(e,/.test(js) && /"text":"inspecting:"/.test(r) && /"translate":"tile\.red_flower\.allium\.name"/.test(r), r);
    }
    {
        // 固定写入简体中文：掉落物名字标签 = k5e(itemStack)（拼英文名）→ 运行时按 ID 找键，再用中文译文拼成纯文字
        const xm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        xm.files.set('BP/scripts/drop.js', Buffer.from('import { world } from "@minecraft/server";\nfunction k5e(e){let t=e.typeId.replace(/^[^:]+:/,"");return t.split(/[_ ]+/).map(i=>i.charAt(0).toUpperCase()+i.slice(1)).join(" ")}\nexport function label(ent, st, n) { ent.nameTag = `${k5e(st)} §6x${n}`; ent.nameTag = k5e(st); }\nexport function hi(p) { p.sendMessage("Your bag is now full"); }\n'));
        const run = async (o) => { const m = new MemFS([...xm.files]); await NS.runPipeline(m, { baseName: 'fixture', ...o }, () => {}); return m.files.get('BP/scripts/drop.js').toString(); };
        const off = await run({});
        const on = await run({ bakeZh: true, bakeLang: new Map([['script.drop.sendmessage', '你的背包满了']]) });
        check('固定写入简体中文：默认不改名字标签；开启后名字标签套 B()，写入用到的键的中文', !/__i18n\.B\(/.test(off) && /nameTag = __i18n\.B\(/.test(on) && /__i18n\.bake\(/.test(on) && /"item\.iron_sword\.name":"铁剑"/.test(on) && /"script\.drop\.sendmessage":"你的背包满了"/.test(on));
        const rt = new Function(on.slice(0, on.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '') + '\nreturn __i18n;')();
        const k5e = new Function('__i18n', on.split('\n').find(l => l.startsWith('function k5e')) + '\nreturn k5e;')(rt);
        const nm = k5e({ typeId: 'minecraft:iron_sword' });
        check('  └ 运行时：拼出的 “Iron Sword” 写成 “铁剑”，“Iron Sword §6x3” 里的名字也换掉；没有译文的保持原文', rt.B(nm) === '铁剑' && rt.B(`${nm} §6x3`) === '铁剑 §6x3' && rt.B('Unknown Thing') === 'Unknown Thing', rt.B(`${nm} §6x3`));
    }
    for (const [t, isCmd] of [['fill -20 64 -20 20 64 20 stone', true], ['setblock 0 69 -20 stone', true], ['tp ~ ~10 ~', true],
        ['Fill the bucket with water', false], ['Time is up!', false], ['list of items: 3 swords', false]]) {
        check(`命令识别：${t} → ${isCmd ? '命令' : '文本'}`, NS.looksLikeCommand(t) === isCmd);
    }
    {
        const c2 = new NS.ExtractContext({});
        NS.processScript('export function f(p, x) { p.runCommand(`setblock ${x} 69 -20 stone`); const a = ["fill -20 65 -20 20 67 20 dirt"]; const b = `setblock ${x} 69 20 stone`; return [a, b]; }', 'scripts/d.js', c2, {});
        check('脚本中的 fill / setblock 命令（含模板字符串）不登记为文本', c2.entries.size === 0, [...c2.entries.values()].map(e => e.value).join(' / '));
    }

    console.log('\n[4] 该提取的都提取了');
    const item = JSON.parse(out('BP/items/sword.json'))['minecraft:item'].components;
    check('物品名', zh.get(item['minecraft:display_name'].value) === '§6烈焰之剑');
    check('物品 interact_button', zh.get(item['minecraft:interact_button']) === '挥动');
    const gem = JSON.parse(out('BP/items/gem.json'))['minecraft:item'].components;
    check('无名物品补 display_name + 占位名', gem['minecraft:display_name'].value === 'item.tianji:spirit_gem.name' && zh.get('item.tianji:spirit_gem.name') === 'Spirit Gem');
    const blk = JSON.parse(out('BP/blocks/altar.json'))['minecraft:block'];
    check('方块名复用已有键 tile.tianji:altar.name', blk.components['minecraft:display_name'] === 'tile.tianji:altar.name');
    check('  └ zh_CN 写入原文“祭坛”，en_US 保留 “Altar”', zh.get('tile.tianji:altar.name') === '祭坛' && en.get('tile.tianji:altar.name') === 'Altar');
    check('方块 permutations 名称', zh.get(blk.permutations[0].components['minecraft:display_name']) === '激活的祭坛');
    check('合成台 table_name', zh.get(blk.components['minecraft:crafting_table'].table_name) === '合成祭坛');
    check('实体新格式 interact.interactions', zh.get(ent.components['minecraft:interact'].interactions[0].interact_text) === '交易');
    check('component_groups 里的交易界面名', zh.get(ent.component_groups.trader['minecraft:economy_trade_table'].display_name) === '神秘商人');
    check('出生蛋名称占位', zh.has('item.spawn_egg.entity.tianji:merchant.name'));
    const cmds = ent.events.e.queue_command.command;
    check('实体事件 title → titleraw', renderCommand(cmds[0], zh) === 'title @a actionbar 商人出现了！');
    check('实体事件 tellraw 保留 selector', renderCommand(cmds[2], zh) === 'tellraw @a §a欢迎 <selector>');
    const dlg = JSON.parse(out('BP/dialogue/npc.json'))['minecraft:npc_dialogue'].scenes[0];
    check('对话正文（换行拆键）', render(dlg.text, zh) === '你好，旅行者！\n欢迎来到村庄。');
    check('对话 rawtext 按钮', render(dlg.buttons[1].name, zh) === '询问');
    check('对话命令', renderCommand(dlg.buttons[0].commands[0], zh) === '/title @initiator title 再见');
    const fnLines = fn.split('\r\n');
    check('mcfunction title', renderCommand(fnLines[1], zh) === 'title @a title §l游戏开始');
    check('mcfunction execute … run title', renderCommand(fnLines[2].trim(), zh) === 'execute as @a[tag=vip,scores={x=1..}] at @s run title @s subtitle VIP 玩家');
    check('mcfunction tellraw + score', renderCommand(fnLines[3], zh) === 'tellraw @a 倒计时 <score>');
    check('mcfunction 带引号的玩家名目标', renderCommand(fnLines[7], zh) === 'title "Steve Jobs" actionbar Hello there');
    check('动画控制器命令', renderCommand(onEntry[0], zh) === '/title @s actionbar 进入战斗');
    const bpMan = JSON.parse(out('BP/manifest.json'));
    const bpZh = NS.parseLang(out('BP/texts/zh_CN.lang'));
    check('行为包名写入行为包自己的 texts', bpMan.header.name === 'pack.name' && bpZh.get('pack.name') === '天机转盘');
    check('资源包名写入资源包自己的 texts', zh.get('pack.name') === '天机转盘资源包');
    check('languages.json 更新', JSON.parse(out('RP/texts/languages.json')).includes('zh_CN'));
    check('lang 中没有真换行导致的残行', !out('RP/texts/zh_CN.lang').split('\n').some(l => l && !l.startsWith('#') && !l.includes('=')));

    // -----------------------------------------------------------
    console.log('\n[4b] 脚本自带的多语言表');
    const vi = mem.files.has('RP/texts/vi_VN.lang') ? NS.parseLang(out('RP/texts/vi_VN.lang')) : new Map();
    const keyOf = (lang, text) => [...lang].find(([, v]) => v === text)?.[0];
    const kS = keyOf(en, 'Light is electromagnetic radiation visible to the human eye.');
    check('s/v 平行字段：英文进 en_US，越南文进 vi_VN，共用同一个键', kS && vi.get(kS) === 'Ánh sáng là bức xạ điện từ mà mắt người nhìn thấy được.');
    check('  └ 越南文没有作为独立的新键出现在 zh_CN / en_US', ![...zh.values()].includes('Ánh sáng là bức xạ điện từ mà mắt người nhìn thấy được.') && ![...en.values()].includes('Ánh sáng là bức xạ điện từ mà mắt người nhìn thấy được.'));
    check('  └ languages.json 加入 vi_VN', JSON.parse(out('RP/texts/languages.json')).includes('vi_VN'));
    const kW = keyOf(zh, '欢迎来到实验室');
    check('按语言代码分组的字典：zh_CN / en_US 共用键', kW && en.get(kW) === 'Welcome to the lab');
    const kD = keyOf(zh, '一把锋利的剑'), kN = keyOf(zh, 'The sword of the king');
    check('name / desc 语言不同但不是翻译：不合并', kD && kN && kD !== kN && en.get(kD) === '一把锋利的剑');
    check('  └ 给出提示而不是自动合并', res.ctx.warnings.some(w => w.includes('name→en_US') && w.includes('未自动合并')));
    {
        const lore = out('BP/scripts/lore.js');
        const reg = JSON.parse(/\.reg\((\[.*?\]), \[/.exec(lore)[1]);
        const m = new Map(reg);
        check('运行时：英文原文和越南文都能查到同一个键', m.get('Water flows downhill when you place it.') === m.get('Nước chảy xuống dốc khi bạn đặt nó.'));
    }

    const es = mem.files.has('RP/texts/es_ES.lang') ? NS.parseLang(out('RP/texts/es_ES.lang')) : new Map();
    const kL = keyOf(en, 'Light is electromagnetic radiation visible to the human eye.');
    check('不同文件都用 s/v 但语言不同：西语进 es_ES、越南语进 vi_VN，同一个键', es.get(kL) === 'La luz es radiación electromagnética visible para el ojo humano.' && vi.get(kL) === 'Ánh sáng là bức xạ điện từ mà mắt người nhìn thấy được.');
    check('  └ 西语原文没有变成独立的新键', ![...zh.values()].some(v => v.startsWith('La luz es')));
    check('输入归一化表 [/正则/, "how many players"] 不提取', ![...zh.values()].includes('how many players'));
    check('关键词判定的回答文本被提取', [...zh.values()].some(v => v.startsWith('The Protestant Reformation')));
    {
        const csv = res.workbook['input_aliases.csv'] || '';
        const rows = csv.replace(/^\ufeff/, '').split('\r\n').map(l => l.split(','));
        const norm = rows.find(r => r[1] === 'how many players');
        check('导出玩家输入匹配表 input_aliases.csv', !!csv && rows.length === 4);
        check('  └ 归一化：拆出正则里的各个说法，识别出已有 es/fr/en', norm && csv.includes('cuántos jugadores | cuantos jugadores') && /es_ES/.test(norm[5]) && /fr_FR/.test(norm[5]) && /en_US/.test(norm[5]));
        check('  └ 列出缺少的语言并留出补充列', norm && /zh_CN/.test(norm[6]) && rows[0].includes('add_zh_CN'));
        const trig = rows.find(r => r[1].startsWith('The Protestant'));
        check('  └ 触发条目关联到回答的翻译键', trig && trig[2] && zh.get(trig[2]) && zh.get(trig[2]).startsWith('The Protestant'));
        check('  └ verity.js 中的正则和关键词保持原样', out('BP/scripts/verity.js').includes('/\\b(?:cuántos jugadores|cuantos jugadores|hay alguien más|hay alguien mas|estoy solo)\\b/gi, "how many players"') && out('BP/scripts/verity.js').includes('keywords: ["reformation", "luther", "protestant", "church"]'));
    }
    {
        const c4 = new NS.ExtractContext({});
        NS.processScript(`export const D = { es: [{ s: "Light is visible to the human eye.", v: "La luz es visible para el ojo humano." }, { s: "Water flows downhill when you place it.", v: "El agua fluye cuesta abajo cuando la colocas." }],
          vi: [{ s: "Light is visible to the human eye.", v: "Ánh sáng là thứ mắt người nhìn thấy được." }, { s: "Water flows downhill when you place it.", v: "Nước chảy xuống dốc khi bạn đặt nó." }] };`, 'scripts/n.js', c4, {});
        const t = c4.translations.get([...c4.entries.keys()][0]);
        check('外层按语言分组、里面仍是 s/v：英文不会被当成西语/越南语译文', c4.entries.size === 2 && t && t.get('en_US') === 'Light is visible to the human eye.' && t.get('es_ES').startsWith('La luz') && t.get('vi_VN').startsWith('Ánh sáng'));
    }
    {
        // 单句常用词很少的英文（逐句判断会失败），且只有两行
        const c5 = new NS.ExtractContext({});
        NS.processScript(`const DIALOGUE_DATA = [
          {"s":"Sound is vibration traveling through matter as pressure waves.","v":"Le son est une vibration qui voyage à travers la matière sous forme d'ondes de pression.","d":false},
          {"s":"Magnetism is force from moving electric charge.","v":"Le magnétisme est la force générée par une charge électrique en mouvement.","d":false}];`, 'scripts/french.js', c5, {});
        const t5 = c5.translations.get([...c5.entries.keys()][0]);
        check('整列判断语言：常用词很少的英文句子也能识别（s→en_US, v→fr_FR）', c5.entries.size === 2 && t5 && t5.get('fr_FR') && t5.get('fr_FR').startsWith('Le son'));
    }
    {
        // Verity 风格的 locale 文件
        const esL = NS.parseLang(out('RP/texts/es_ES.lang'));
        const kv = (t) => [...en].find(([, v]) => v === t)?.[0];
        check('Verity：${name} 占位符 → 句式键（%1$s），西语对应', esL.get(kv('Good afternoon, %1$s.')) === 'Buenas tardes, %1$s.');
        check('Verity：短句成对数组（"Ouch!" → "¡Ay!"）', esL.get(kv('Ouch!')) === '¡Ay!');
        check('Verity：逐条 .set("英文", "西语")', esL.get(kv('Evening. I\'m listening.')) === 'Buenas noches. Te escucho.');
        check('Verity：名称字典（键为英文）', esL.get(kv('ocean monument')) === 'monumento oceánico');
        check('Verity：句式规则 正则 → 模板', esL.get(kv('%1$s out of %2$s hearts.')) === '%1$s de %2$s corazones.');
        check('Verity：输入归一化表 INPUT_TERMS 不合并、不登记', ![...zh.values()].includes('aldea') && ![...zh.values()].includes('portal del end') && !esL.get(kv('village')));
    }
    {
        const lf = { mode: 'manual', map: new Map(), fileMaps: [['x_lang.js', new Map([['s', 'en_US'], ['v', 'fr_FR']])]] };
        const c3 = new NS.ExtractContext({});
        NS.processScript('export const D = [{ s: "Hello there friend", v: "Salut l\'ami" }];', 'scripts/x_lang.js', c3, { langFields: lf });
        const k = [...c3.entries.keys()][0];
        check('按文件手动指定：x_lang.js:v=fr_FR', c3.translations.get(k)?.get('fr_FR') === "Salut l'ami");
    }

    console.log('\n[5] 脚本运行时对比（原脚本 vs 改写后，模拟 @minecraft/server）');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-'));
    const mockServer = `
export const calls = [];
const H = {};
export const world = {
  afterEvents: { playerSpawn: { subscribe: f => (H.spawn = f) } },
  beforeEvents: { chatSend: { subscribe: f => { const prev = H.chat; H.chat = prev ? (e) => { prev(e); f(e); } : f; } } },
  sendMessage: m => calls.push(['world.sendMessage', m]),
  getAllPlayers: () => world.players,
  getDimension: () => ({ runCommand: c => calls.push(['dim.runCommand', c]) }),
  players: [],
};
export const system = { runInterval: f => (H.tick = f), run: f => f() };
export const __H = H;
export function makePlayer(name, money) {
  return {
    name, nameTag: '',
    getDynamicProperty: () => money,
    sendMessage: m => calls.push(['sendMessage', m]),
    runCommand: c => calls.push(['runCommand', c]),
    hasTag: () => true, isOp: () => false,
    onScreenDisplay: { setTitle: (t, o) => calls.push(['setTitle', t, o && o.subtitle]), setActionBar: t => calls.push(['setActionBar', t]) },
  };
}`;
    const mockUi = `
import { calls } from '@minecraft/server';
class Base {
  constructor(kind) { this.kind = kind; }
  _r(m, ...a) { calls.push([this.kind + '.' + m, ...a]); return this; }
  title(t) { return this._r('title', t); } body(t) { return this._r('body', t); }
  button(t) { return this._r('button', t); } button1(t) { return this._r('button1', t); } button2(t) { return this._r('button2', t); }
  toggle(t, o) { return this._r('toggle', t, o && o.tooltip); } slider(t) { return this._r('slider', t); }
  dropdown(t, opts) { return this._r('dropdown', t, ...opts); } textField(t, p, o) { return this._r('textField', t, p, o && o.defaultValue); }
  show() { return Promise.resolve(globalThis.__resp || { canceled: true }); }
}
export class ActionFormData extends Base { constructor() { super('Action'); } }
export class ModalFormData extends Base { constructor() { super('Modal'); } }
export class MessageFormData extends Base { constructor() { super('Message'); } }`;
    const driver = `
import { calls, world, __H, makePlayer } from '@minecraft/server';
const main = await import('./scripts/main.js');
await import('./scripts/verity.js');
const p = makePlayer('Alex', 120);
world.players = [p];
__H.spawn({ player: p, initialSpawn: true });
globalThis.__resp = { canceled: false, selection: 0 };
await main.openShop(p);
globalThis.__resp = { canceled: false, selection: 1 };
await main.openShop(makePlayer('Bob', 10));
await main.settings(p);
await main.confirm(p);
await main.menu(p);
__H.tick();
main.broadcast();
__H.chat({ message: '¿Cuántos jugadores hay?', sender: p });
__H.chat({ message: 'what was the reformation', sender: p });
console.log(JSON.stringify(calls));`;
    const setup = (name, files) => {
        const d = path.join(tmp, name);
        for (const [rel, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
            fs.writeFileSync(path.join(d, rel), content);
        }
        fs.mkdirSync(path.join(d, 'node_modules/@minecraft/server'), { recursive: true });
        fs.mkdirSync(path.join(d, 'node_modules/@minecraft/server-ui'), { recursive: true });
        fs.writeFileSync(path.join(d, 'node_modules/@minecraft/server/package.json'), '{"type":"module","main":"index.js"}');
        fs.writeFileSync(path.join(d, 'node_modules/@minecraft/server-ui/package.json'), '{"type":"module","main":"index.js"}');
        fs.writeFileSync(path.join(d, 'node_modules/@minecraft/server/index.js'), mockServer);
        fs.writeFileSync(path.join(d, 'node_modules/@minecraft/server-ui/index.js'), mockUi);
        fs.writeFileSync(path.join(d, 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(d, 'driver.js'), driver);
        return JSON.parse(execFileSync('node', [path.join(d, 'driver.js')], { cwd: d }).toString());
    };
    const scripts = (get) => Object.fromEntries(['main', 'data', 'menu', 'verity'].map(n => [`scripts/${n}.js`, get(`BP/scripts/${n}.js`)]));
    const origCalls = setup('orig', scripts(p => before.get(p).toString()));
    const newCalls = setup('new', scripts(out));

    const show = (c, lang) => c.map((x, i) => {
        if (i === 0) return x;
        if (/runCommand/.test(c[0]) && typeof x === 'string') return renderCommand(x, lang);
        return render(x, lang);
    }).join(' | ');
    check(`调用次数一致（${origCalls.length}）`, origCalls.length === newCalls.length);
    let same = 0;
    const diffs = [];
    origCalls.forEach((c, i) => {
        const a = show(c, zh), b = show(newCalls[i] || [], zh);
        if (a === b) same++; else diffs.push(`原: ${a}\n      新: ${b}`);
    });
    check(`改写后用 zh_CN 渲染与原脚本显示完全一致（${same}/${origCalls.length}）`, diffs.length === 0, diffs.join('\n      '));
    const raw = newCalls.filter(c => !/runCommand/.test(c[0])).flatMap(c => c.slice(1)).filter(x => typeof x === 'string' && NS.hasCJK(x));
    check('没有残留未翻译的中文纯字符串参数', raw.length === 0, raw.join(' / '));

    // 模拟一份“英文翻译”：所有值包上 EN(...)，确认动态数据也走翻译
    const fake = new Map([...zh].map(([k, v]) => [k, v.startsWith('%1$s') && v.length < 6 ? v : `EN(${v})`]));
    console.log('\n  模拟翻译后的玩家视角（节选）：');
    newCalls.slice(0, 40).forEach(c => {
        const s = show(c, fake);
        if (/EN\(/.test(s)) console.log('    ' + s.replace(/\n/g, '⏎'));
    });
    const buy = newCalls.find(c => c[0] === 'sendMessage' && JSON.stringify(c[1]).includes('sendmessage_1'));
    check('动态数据（商店商品名）在句式中也被翻译', buy && render(buy[1], fake) === '§aEN(购买成功：EN(钻石剑) ×1)', buy && render(buy[1], fake));
    const welcome = newCalls.find(c => c[0] === 'world.sendMessage');
    check('变量传递的拼接句式通过运行时匹配翻译', welcome && render(welcome[1], fake) === 'EN(欢迎 Alex 加入服务器)', welcome && render(welcome[1], fake));
    const menuTitle = newCalls.find(c => c[0] === 'Action.title' && JSON.stringify(c[1]).includes('script.main.str'));
    check('自定义 Menu 类经 this.form.title() 也被翻译（§l 前缀剥离）', menuTitle && render(menuTitle[1], fake) === '§lEN(自定义菜单)', menuTitle && JSON.stringify(menuTitle[1]));
    const bc = newCalls.find(c => c[0] === 'dim.runCommand');
    check('数组里的命令在运行时转换为 titleraw', bc && renderCommand(bc[1], fake) === 'title @a title EN(服务器即将重启)', bc && bc[1]);

    const verityReplies = newCalls.filter(c => c[0] === 'sendMessage').slice(-2).map(c => render(c[1], zh));
    check('Verity：西语提问经正则归一化后仍触发正确回答（已翻译）', verityReplies[0] === 'There are a few players online right now.' && verityReplies[1].startsWith('The Protestant Reformation'), verityReplies.join(' / '));
    fs.rmSync(tmp, { recursive: true, force: true });

    // -----------------------------------------------------------
    console.log('\n[6] 世界存档（test/world-fixture，含个人 Xbox ID，不提交到仓库；不存在时跳过）');
    if (fs.existsSync(path.join(__dirname, 'world-fixture', 'db', 'CURRENT'))) {
        const wm = new MemFS(readDir(path.join(__dirname, 'world-fixture')));
        const wr = await NS.runWorldPipeline(wm, { baseName: 'test', listCommandBlockNames: true }, () => {});
        const dbf = new Map([...wm.files].filter(([p]) => p.startsWith('db/')).map(([p, v]) => [p.slice(3), new Uint8Array(v)]));
        const db = await NS.LevelDB.openDb(dbf);
        const tags = db.entries().flatMap(e => {
            const k = e.key;
            const nb = ((k.length === 9 || k.length === 13) && k[k.length - 1] === 49) || String.fromCharCode(...k.subarray(0, 11)) === 'actorprefix';
            return nb ? NS.NBT.readAll(e.value).map(t => t.v) : [];
        });
        const G = NS.NBT.getStr, C = NS.NBT.child;
        const wl = NS.parseLang(wm.files.get('resource_packs/world_texts/texts/zh_CN.lang'));
        const rr = (s) => render(JSON.parse(s), wl);
        const sign = tags.find(c => G(c, 'id') === 'Sign');
        check('告示牌正反面 → rawtext 翻译键', rr(G(C(sign, 'FrontText').v, 'Text')) === '这是一条测试文本' && rr(G(C(sign, 'BackText').v, 'Text')) === '这也是一条测试文本');
        const hang = tags.find(c => G(c, 'id') === 'HangingSign');
        check('悬挂告示牌（含小写单词 hello）', rr(G(C(hang, 'FrontText').v, 'Text')) === '你好' && rr(G(C(hang, 'BackText').v, 'Text')) === 'hello');
        const cmds = tags.filter(c => G(c, 'id') === 'CommandBlock').map(c => G(c, 'Command'));
        check('命令方块 title / titleraw → 翻译键', cmds.filter(c => c.startsWith('/titleraw') && c.includes('"translate"')).length === 2);
        const tr = cmds.filter(c => /^\/?tellraw @a /.test(c)).map(c => JSON.parse(c.slice(c.indexOf('{'))));
        check('命令方块 say / tell → tellraw，发送者用方块名', tr.length === 2 && tr.every(j => rr(JSON.stringify({ rawtext: [j.rawtext[3]] })) === '这是一条测试文本') && tr.some(j => j.rawtext[1].text === 'say' || j.rawtext[1].text === '@') && !cmds.some(c => /^\/?(say|tell) /.test(c)));
        const npc = tags.find(c => G(c, 'identifier') === 'minecraft:npc');
        const acts = JSON.parse(G(npc, 'Actions'));
        check('NPC 名字、正文、按钮 → 翻译键', rr(G(npc, 'RawtextName')) === '你好,claude' && rr(G(npc, 'InterativeText')) === '这是一条测试文本' && rr(acts[0].button_name) === '这是一条测试文本');
        check('NPC 按钮命令保持不变', acts[0].data[0].cmd_line === '/give @a command_block');
        {
            // 世界名称：列在需人工处理最前面，修改后写回 level.dat 的 LevelName 和 levelname.txt
            const nm = new MemFS(readDir(path.join(__dirname, 'world-fixture')));
            const ns = await NS.openWorld(nm, {}, () => {});
            const u0 = ns.ctx.untranslatable[0];
            ns.setValue(u0.ref, '我的测试世界');
            await ns.build(nm, () => {});
            const lvb = nm.files.get('level.dat');
            const lt = NS.NBT.readAll(new Uint8Array(lvb).subarray(8));
            check('世界名称可修改：写回 level.dat 的 LevelName 和 levelname.txt', /世界名称/.test(u0.where) && NS.NBT.getStr(lt[0].v, 'LevelName') === '我的测试世界' && String(nm.files.get('levelname.txt')) === '我的测试世界');
        }
        {
            const sx = await NS.openWorld(new MemFS(readDir(path.join(__dirname, 'world-fixture'))), { listCommandBlockNames: true }, () => {});
            const sd = await NS.openWorld(new MemFS(readDir(path.join(__dirname, 'world-fixture'))), {}, () => {});
            check('默认不列出命令方块名称（转换前选项可开启）', !sd.ctx.untranslatable.some(u => u.where === '命令方块名称') && sd.ctx.untranslatable.filter(u => u.where === '方块名称').length === sx.ctx.untranslatable.filter(u => u.where === '方块名称').length && sx.ctx.untranslatable.some(u => u.where === '命令方块名称'));
            const n0 = sx.workbook()['untranslatable.csv'].split('\n').filter(l => l.includes('命令方块名称')).length;
            sx.hiddenCats.add('命令方块名称');
            const csv1 = sx.workbook()['untranslatable.csv'];
            check('取消勾选“命令方块名称”后不进入导出的待翻译表', n0 === 2 && !csv1.includes('命令方块名称') && csv1.includes('方块名称') && NS.worldCategoryOf({ where: '命令方块名称' }) === '命令方块名称');
        }
        check('命名的命令方块：名称列入需人工翻译', wr.ctx.untranslatable.filter(u => u.where === '命令方块名称').map(u => u.text).sort().join() === 'say,titleraw');
        check('箱子名、物品名、书名、盔甲架名记入报告', ['也许能修改这个名字', '也许你能改变这个物品的名字', '你能改书名吗？', '能改nametag吗？'].every(t => wr.ctx.untranslatable.some(u => u.text === t)));
        const chest = tags.find(c => G(c, 'id') === 'Chest');
        const pg = NS.NBT.toPlain(10, chest).Items[1].tag.pages[0].text;
        check('成书正文 → 翻译键（游戏内实测有效）', rr(pg) === '当然，这也是一条测试文本' && pg.length <= 256 && !wr.ctx.untranslatable.some(u => u.text === '当然，这也是一条测试文本'));
        check('存档登记了新资源包', JSON.parse(wm.files.get('world_resource_packs.json'))[0].pack_id === JSON.parse(wm.files.get('resource_packs/world_texts/manifest.json')).header.uuid);
        check('数据库其它键不受影响', db.info.keys === 24);

        // NBT 编辑器：人工修改 + 导入翻译表 + 改世界名 + 类型校验
        const em = new MemFS(readDir(path.join(__dirname, 'world-fixture')));
        const ss = await NS.openWorld(em, { listCommandBlockNames: true }, () => {});
        const refOf = (where) => ss.ctx.untranslatable.find(u => u.where === where).ref;
        ss.setValue(refOf('方块名称'), 'Mystery Chest');
        const rows = NS.worldParseCsv(ss.workbook()['untranslatable.csv'].slice(1));
        const h = rows[0];
        for (const r of rows.slice(1)) if (r[h.indexOf('where')] === '实体名字标签') r[h.indexOf('translation')] = 'Can I rename it?';
        const imp = ss.importCsv(rows.map(r => r.map(x => /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x).join(',')).join('\n'));
        ss.setValue(ss.search('LevelName')[0].ref, 'My World (EN)');
        let typeErr = '';
        try { ss.setValue(ss.search('TickDelay')[0].ref, 'abc'); } catch (e) { typeErr = e.message; }
        await ss.build(em, () => {}); await ss.build(em, () => {});
        const db3 = await NS.LevelDB.openDb(new Map([...em.files].filter(([p]) => p.startsWith('db/')).map(([p, v]) => [p.slice(3), new Uint8Array(v)])));
        const plain = db3.entries().flatMap(e => { const k = e.key; return (((k.length === 9 || k.length === 13) && k[k.length - 1] === 49) || String.fromCharCode(...k.subarray(0, 11)) === 'actorprefix') ? NS.NBT.readAll(e.value).map(t => NS.NBT.toPlain(t.t, t.v)) : []; });
        check('编辑器：人工修改箱子名写回存档', plain.find(p => p.id === 'Chest').CustomName === 'Mystery Chest');
        check('编辑器：导入翻译表批量写回', imp.applied === 1 && plain.find(p => p.identifier === 'minecraft:armor_stand').CustomName === 'Can I rename it?');
        const ld = new Uint8Array(em.files.get('level.dat'));
        check('编辑器：改世界名（level.dat + levelname.txt）', NS.NBT.getStr(NS.NBT.readAll(ld.subarray(8))[0].v, 'LevelName') === 'My World (EN)' && em.files.get('levelname.txt') === 'My World (EN)' && new DataView(ld.buffer, ld.byteOffset).getInt32(4, true) === ld.length - 8);
        check('编辑器：数字字段类型校验', typeErr === '需要整数');
        check('编辑器：多次生成不会重复登记资源包', JSON.parse(em.files.get('world_resource_packs.json')).length === 1);
    }

    // -----------------------------------------------------------
    console.log('\n[6b] 玩家数据（脚本生成的测试存档，不含个人信息）');
    {
        const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-'));
        execFileSync('node', [path.join(__dirname, 'make-world.js'), wdir]);
        const pm = new MemFS(readDir(wdir));
        const ss = await NS.openWorld(pm, {}, () => {});
        const texts = ss.ctx.untranslatable.map(u => u.text);
        check('玩家背包、盔甲栏、末影箱（含潜影盒内）的物品名、书名列出', ['冒险日志', '勇者之剑', '守卫头盔', '秘密笔记'].every(t => texts.includes(t)));
        check('玩家身上的成书正文（含末影箱潜影盒内）自动转为翻译键', !texts.includes('第一天：我来到了这片大陆。') && !texts.includes('宝藏在出生点下面。') &&
            ['第一天：我来到了这片大陆。', '宝藏在出生点下面。'].every(t => [...ss.ctx.entries.values()].some(e => e.value === t)));
        check('书与笔（未签名）保持原样，列入需人工翻译', texts.includes('草稿：还没写完。'));
        ss.setValue(ss.ctx.untranslatable.find(u => u.text === '冒险日志').ref, 'Journal');
        await ss.build(pm, () => {});
        const db = await NS.LevelDB.openDb(new Map([...pm.files].filter(([p]) => p.startsWith('db/')).map(([p, v]) => [p.slice(3), new Uint8Array(v)])));
        const pl = NS.NBT.toPlain(10, NS.NBT.readAll(db.get(new TextEncoder().encode('~local_player')))[0].v);
        const wl = NS.parseLang([...pm.files].find(([p]) => p.endsWith('zh_CN.lang'))[1]);
        check('写回后：成书页为翻译键、书名为手动修改值、书与笔不变', render(JSON.parse(pl.EnderChestInventory[0].tag.Items[0].tag.pages[0].text), wl) === '宝藏在出生点下面。' &&
            pl.Inventory[0].tag.title === 'Journal' && pl.Inventory[2].tag.pages[0].text === '草稿：还没写完。');

        // 超长自动分页（书与笔、手动修改的页面；每页 ≤256 字符、≤14 行，整本 ≤50 页）
        const ss2 = await NS.openWorld(new MemFS(readDir(wdir)), {}, () => {});
        const long = 'I walked across the endless plains, past villages and rivers, looking for the old tower. '.repeat(6).trim();
        const bref = ss2.ctx.untranslatable.find(u => u.text === '草稿：还没写完。').ref;
        ss2.setValue(bref, long);
        const pagesNode = NS.worldNodeAt(ss2.resolve(bref).rec, JSON.parse(bref.slice(bref.indexOf('|') + 1)).slice(0, -2)).v;
        const texts2 = pagesNode.items.map(p => NS.NBT.getStr(p, 'text'));
        check('超长自动分页：每页 ≤256 字符，拼回与原文一致', texts2.length === 3 && texts2.every(t => t.length <= 256) && texts2.join(' ').replace(/\s+/g, ' ') === long);
        check('  └ 新页列入需人工翻译，位置引用正确', ss2.ctx.untranslatable.filter(u => /自动分页/.test(u.where)).every(u => ss2.getText(u.ref) === u.text) && ss2.ctx.untranslatable.filter(u => /自动分页/.test(u.where)).length === 2);
        check('  └ 书名超过 16 字给出提醒', (ss2.setValue(ss2.ctx.untranslatable.find(u => u.text === '冒险日志').ref, "An Adventurer's Journal"), /16/.test(ss2.notice)));
        check('从零生成的存档也能正常读写（告示牌转换）', [...ss.ctx.entries.values()].some(e => e.value === '欢迎'));
        fs.rmSync(wdir, { recursive: true, force: true });
    }

    // -----------------------------------------------------------
    console.log('\n[7] 结构文件 .mcstructure');
    {
        const sb = fs.readFileSync(path.join(__dirname, 'fixture', 'BP', 'structures', 'village.mcstructure'));
        const ss = await NS.openStructure('village.mcstructure', new Uint8Array(sb), {}, () => {});
        const keys = [...ss.ctx.entries.keys()];
        check('结构：告示牌（多行）、命令方块、NPC 名字/正文/按钮 → 翻译键', ['sign.0_0_0.front', 'sign.0_0_0.back', 'command.1_0_0', 'npc.n12345.name', 'npc.n12345.text', 'npc.n12345.button_0'].every(k => keys.includes('structure.village.' + k)));
        check('结构：箱子名、物品名、物品描述列为需人工处理', ['村长的箱子', '村长的剑', '传家之宝'].every(t => ss.ctx.untranslatable.some(u => u.text === t && u.ref)));
        const hits = ss.search('CustomName', 1e6);
        const rows = [['ref', 'translation'], ...hits.map(h => [h.ref, h.value === '村长的箱子' ? "Elder's Chest" : h.value === 'NPC' ? 'Elder' : ''])];
        const imp = ss.importCsv(rows.map(r => r.map(x => /[",\n']/.test(x) ? `"${x.replace(/"/g, '""')}"` : x).join(',')).join('\n'));
        const out = await ss.build();
        const back = NS.NBT.toPlain(10, NS.NBT.readAll(out.structure)[0].v);
        const bpd = back.structure.palette.default.block_position_data;
        check('结构：搜索结果导出 / 导入批量修改', imp.applied === 2 && bpd['4'].block_entity_data.CustomName === "Elder's Chest" && back.structure.entities[0].CustomName === 'Elder');
        check('结构：其余数据保持不变', back.size.join() === '3,2,1' && back.structure.block_indices[0].join() === '0,4,1,4,2,4' && back.structure.palette.default.block_palette.length === 5);
        check('结构：生成翻译资源包', out.pack && NS.parseLang(out.pack.get('texts/zh_CN.lang')).get('structure.village.npc.n12345.name') === '村长');
        const zhA = NS.parseLang(out_('RP/texts/zh_CN.lang'));
        check('附加包里的 structures/*.mcstructure 随附加包转换，翻译写进附加包资源包', zhA.get('structure.village.sign.0_0_0.back') === 'Welcome to the village');
    }

    {
        // 再次转换原包：放回翻译好的 lang（只放目标语言）→ 键名和上次一致，译文保留，不重复建键
        const fx = path.join(__dirname, 'fixture');
        const m1 = new MemFS(readDir(fx));
        await NS.runPipeline(m1, { baseName: 'fixture' }, () => {});
        const en1 = NS.parseLang(m1.files.get('RP/texts/en_US.lang').toString());
        const tr = m1.files.get('RP/texts/en_US.lang').toString().replace(/^([^#\s=][^=\n]*)=.*$/mg, (l, k) => `${k}=EN:${k}`);
        const o = readDir(fx); o.set('RP/texts/en_US.lang', Buffer.from(tr + '\nscript.main.str_999=EN:old line that was removed\n'));
        const m2 = new MemFS(o);
        await NS.runPipeline(m2, { baseName: 'fixture' }, () => {});
        const en2 = NS.parseLang(m2.files.get('RP/texts/en_US.lang').toString());
        const lost = [...en2.keys()].filter(k => !String(en2.get(k)).startsWith('EN:'));
        check('再次转换：沿用放回的译文 lang，键名一致、不新建重复键', en2.size === en1.size && lost.length === 0, JSON.stringify({ n1: en1.size, n2: en2.size, lost: lost.slice(0, 5) }));
        const zh2 = NS.parseLang(m2.files.get('RP/texts/zh_CN.lang').toString());
        check('再次转换：放回的 lang 里已用不到的旧键被删除', !en2.has('script.main.str_999') && !zh2.has('script.main.str_999'));
    }
    {
        // 需人工翻译：下载后再改、改回原文都能写回；表格序号对不上时按原文找回
        const sm = new MemFS(readDir(path.join(__dirname, 'fixture')));
        const res = await NS.runPipeline(sm, { baseName: 'fixture' }, () => {});
        const ss = res.manualSession;
        const u = ss.ctx.untranslatable.filter(x => x.ref && x.ref.startsWith('F|'));
        for (const x of u) ss.setValue(x.ref, 'A' + x.text);
        await ss.applyTo(sm);
        for (const x of u) ss.setValue(x.ref, 'B' + x.text);
        const ap2 = await ss.applyTo(sm);
        const ok2 = u.every(x => sm.files.get(x.file).toString().includes('B'));
        ss.setValue(u[0].ref, u[0].text);
        const ap3 = await ss.applyTo(sm);
        check('需人工翻译：下载后再修改、改回原文也能写回', ap2.missed === 0 && ok2 && ap3.missed === 0 && ap3.files === 1, JSON.stringify({ ap2, ap3 }));
        const res2 = await NS.runPipeline(new MemFS(readDir(path.join(__dirname, 'fixture'))), { baseName: 'fixture' }, () => {});
        const csv = 'ref,file,where,text,translation\n' + res2.manualSession.ctx.untranslatable.filter(x => x.ref && x.ref.startsWith('F|'))
            .map((x, i, a) => [a[(i + 1) % a.length].ref, x.file, x.where, x.text, 'C'].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        const imp = res2.manualSession.importCsv(csv);
        const got = res2.manualSession.ctx.untranslatable.filter(x => x.ref && x.ref.startsWith('F|')).every(x => res2.manualSession.getText(x.ref) === 'C');
        check('导入翻译表：ref 序号对不上时按原文找回对应条目', got && imp.applied >= 4, JSON.stringify(imp));
    }
    {
        // BR：任务奖励 arr.push({translate:`- ${名字} (${a}-${b})`})、自定义效果名 + 等级时间、界面比较的标题以 s 结尾
        const ctx = new NS.ExtractContext({});
        const src = 'import { world } from "@minecraft/server";\n'
            + 'function $a(e){return kge(e?.replace(/\\w+:/,""))}function kge(e){return e?.replace(/[_.]/g," ")?.replace(/\\w\\S*/g,t=>t.charAt(0)?.toUpperCase()+t?.substr(1)?.toLowerCase())}\n'
            + 'function R_(e){let a=e.split(":").pop();let i=a.replace(/[_-]+/g," ").trim();return i.split(/\\s+/g).map(r=>r.charAt(0).toUpperCase()+r.slice(1)).join(" ")}\n'
            + 'var Sg="5fs_br:illumination";we.registerEffect(Sg,{});\n'
            + 'const D={t:"Advancements"};\n'
            + 'export function f(p,n,r,s,f){const e=[];e.push({translate:`§8- §8${R_(n)} §5(${r}-${s}) `});p.sendMessage({rawtext:e});f.title(D.t);p.setActionBar(`${$a(n)} ${r}`);}\n';
        const out = NS.processScript(src, 'scripts/br.js', ctx, { injectRuntime: true, runtimeKey: '__br_q', uiCompared: new Set(['Advancements']), idKeys: () => [] }).content;
        const head = out.slice(0, out.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '');
        const rest = out.split('\n').filter(l => /^__i18n\.(reg|keep|regIds)\(/.test(l)).join('\n');
        const rt = new Function(head + rest + '\nreturn __i18n;')();
        rt.regIds({ 'minecraft:emerald': 'item.emerald.name' });
        rt.reg([['Advancements', 'k.adv']], []);
        check('push 进数组的 {translate:`- ${名字} (…)`} 换成文字 + 参数', !/translate:`/.test(out) && /e\.push\(\{"text":"§8- §8"\},__i18n\.T\(R_\(n\)\)/.test(out), out.slice(out.indexOf('export function f'), out.indexOf('export function f') + 200));
        rt.H('minecraft:emerald', 'Emerald');
        check('奖励里的原版物品名经 H 翻译', JSON.stringify(rt.T('Emerald')) === '{"rawtext":[{"translate":"item.emerald.name"}]}');
        const ill = JSON.stringify(rt.M('Illumination III (0:44)'));
        check('自定义效果名提取，"名字 + 等级 + 时间" 只翻译名字', [...ctx.entries.values()].some(e => e.value === 'Illumination') && /"translate":"script\.br\.effect\.illumination"\},\{"text":" III \(0:44\)"\}/.test(ill), ill);
        check('界面拿来比较的标题以 s 结尾也保持原文（运行时正则转义）', rt.M('Advancements') === 'Advancements' && rt.M('§lAdvancements ') === '§lAdvancements ');
    }
    {
        // 脚本读回 lore（getLore）按英文判断哪些行是自己加的再重写：lore 写成键后要还原成原文，否则每次再追加一遍
        const ctx = new NS.ExtractContext({});
        const src = 'import { world } from "@minecraft/server";\nconst B="§r§6Ancient Bark 0/3 Repairs Left";\nfunction A(e){return typeof e=="string"&&(e.includes("Ancient Bark")||e.startsWith("§r§7Durability: §f"))}\n'
            + 'export function f(a,m,d){let n=[];try{n=a.getComponent("x").getLore()??[]}catch{n=a.getLore?.()??[]}const r=[`§r§7Durability: §f${m} / ${d}`,B];a.setLore([...n.filter(x=>!A(x)),...r]);}\n'
            + 'export function c(a,b){b.setLore(a.getLore());}';
        const js = NS.processScript(src, 'scripts/lore.js', ctx, { injectRuntime: true, runtimeKey: '__lore_t', rawLore: true }).content;
        const head = js.slice(0, js.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '');
        const body = js.slice(js.indexOf('// ---- end i18n runtime ----')).replace(/^import.*$/mg, '').replace(/export function/g, 'function');
        const fns = new Function(head + body + ';return { f, c };')();
        let stored = ['Custom'];
        const item = { getComponent() { return undefined; }, getLore() { return stored.map(x => typeof x === 'string' ? x : ''); }, getRawLore() { return stored.map(x => typeof x === 'string' ? { text: x } : x); }, setLore(v) { stored = v; } };
        for (let i = 0; i < 3; i++) fns.f(item, 2999 - i, 3000);
        let copied = null;
        fns.c(item, { setLore(v) { copied = v; } });
        check('读回 lore 还原成原文：反复更新不重复追加；复制 lore 仍是翻译键', stored.length === 3 && stored[0] === 'Custom' && JSON.stringify(stored[1]).includes('"2997"')
            && Array.isArray(copied) && copied.length === 3 && JSON.stringify(copied[1]).includes('translate'), JSON.stringify(stored).slice(0, 300));
    }
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
