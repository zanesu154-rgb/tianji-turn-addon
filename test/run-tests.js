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
        const wr = await NS.runWorldPipeline(wm, { baseName: 'test' }, () => {});
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
            const sx = await NS.openWorld(new MemFS(readDir(path.join(__dirname, 'world-fixture'))), {}, () => {});
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
        const ss = await NS.openWorld(em, {}, () => {});
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

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
