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
    check('say 未改并记入报告', fn.includes('say 游戏开始了') && res.ctx.untranslatable.some(u => u.text === '游戏开始了'));
    check('计分板显示名记入报告', res.ctx.untranslatable.some(u => u.text === '击杀数'));
    check('战利品表 set_name 未改（游戏不翻译自定义名称）', !changed.includes('BP/loot_tables/chest.json') && res.ctx.untranslatable.some(u => u.text === '传说宝箱'));
    const ent = JSON.parse(out('BP/entities/merchant.json'))['minecraft:entity'];
    check('实体 nameable.name_filter 未动', ent.components['minecraft:nameable'].name_actions[0].name_filter === 'Toast');
    check('实体 boss 名未动并记入报告', ent.components['minecraft:boss'].name === '神秘商人BOSS');
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
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
