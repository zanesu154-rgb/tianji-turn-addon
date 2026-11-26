// #168 ACHV 路由标记标题的永久回归。无私人输入。
// 对照方式：基线 = 同一份输入、资源包界面里没有 `- 'ACHV'` 路由（此时 ACHV 保护完全不启用，行为与修复前的 main 相同）；
// 其余路由标记（IDCARD/TITLE/ACHT/CHEAT）在基线和目标两边都保留，用来证明它们不受影响。
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { NS, MemFS, readDir } = require('./load.js');

const SCRIPT = 'BP/scripts/ui.js';
const T = 'ACHV§l Progress', I = 'IDCARD§l Student ID';
const mkRoute = (markers) => ({
    bindings: markers.map(m => ({ binding_type: 'view', source_property_name: `(not ((#title_text - '${m}') = #title_text))`, target_property_name: '#visible' })),
});
const OTHER_MARKERS = ['IDCARD', 'TITLE', 'ACHT', 'CHEAT'];
const prelude = 'import { ActionFormData } from "@minecraft/server-ui";\n';
const fn = (name, title) => `export function ${name}(p) {\n  const gui = new ActionFormData();\n  gui.title(${JSON.stringify(title)});\n  return gui.show(p);\n}\n`;
const msg = (name, text) => `export function ${name}(p) {\n  p.sendMessage(${JSON.stringify(text)});\n}\n`;
const langFile = (entries) => '## ==== addon-i18n ====\n' + [...entries].map(([k, v]) => k + '=' + v).join('\n') + '\n';

async function convert(source, { achv, existing = {}, extra = {} }) {
    const files = readDir(path.join(__dirname, 'fixture'));
    files.set(SCRIPT, Buffer.from(source));
    for (const [p, c] of Object.entries(extra)) files.set(p, Buffer.from(c));
    files.set('RP/ui/server_form.json', Buffer.from(JSON.stringify(mkRoute(achv ? ['ACHV', ...OTHER_MARKERS] : OTHER_MARKERS))));
    for (const [lang, m] of Object.entries(existing)) files.set('RP/texts/' + lang + '.lang', Buffer.from(langFile(m)));
    const mem = new MemFS(files);
    const { ctx } = await NS.runPipeline(mem, { baseName: 'fixture', targetLangs: ['en_US', 'zh_CN'], processScripts: true, injectRuntime: true }, () => {});
    const scripts = {};
    for (const [p, v] of mem.files) if (/^BP\/scripts\/(ui|other)\.js$/.test(p)) {
        const text = String(v);
        acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });   // 生成脚本必须仍是合法模块
        // keep([...]) 列的是资源包界面比较用的文字；基线里没有 ACHV 路由所以少一个 ACHV。这是 main 已有的机制，比较时抹掉
        scripts[p] = text.replace(/\.keep\(\[[^\]]*\]/g, '.keep([]');
    }
    const titlesOf = (text) => text.split('\n').filter(l => l.includes('gui.title(')).map(l => {
        const arg = l.slice(l.indexOf('gui.title(') + 10, l.lastIndexOf(');'));
        try { return JSON.parse(arg); } catch { return arg; }
    });
    return {
        ctx, scripts, titles: titlesOf(scripts[SCRIPT]),
        en: [...NS.parseLang(String(mem.files.get('RP/texts/en_US.lang')))],
        zh: [...NS.parseLang(String(mem.files.get('RP/texts/zh_CN.lang')))],
        warnACHV: ctx.warnings.filter(w => /ACHV/.test(w)),
    };
}
const pair = async (source, opts = {}) => ({ base: await convert(source, { ...opts, achv: false }), cand: await convert(source, { ...opts, achv: true }) });

const keyOf = (t) => typeof t === 'string' ? null : t.rawtext.find(n => n.translate)?.translate;
const render = (t, lang) => { const m = new Map(lang); return typeof t === 'string' ? t : t.rawtext.map(n => n.text ?? m.get(n.translate)).join(''); };
const split = (t, key) => assert.deepEqual(t, { rawtext: [{ text: 'ACHV' }, { text: '§l ' }, { translate: key }] });
const countAchv = (s) => s.split('ACHV').length - 1;
// 除目标键外，有序键值必须逐项相同
function sameExcept(a, b, target) {
    for (const lang of ['en', 'zh']) {
        const strip = (arr) => arr.filter(([k]) => k !== target);
        assert.deepEqual(strip(a[lang]), strip(b[lang]), lang + ': 非目标键、顺序、值');
        assert.deepEqual(a[lang].map(([k]) => k), b[lang].map(([k]) => k), lang + ': 键序（含目标键）');
    }
    assert.deepEqual(a.titles.map((t, i) => i && keyOf(t)), b.titles.map((t, i) => i && keyOf(t)));
}
function identical(a, b) {
    assert.deepEqual(a.en, b.en); assert.deepEqual(a.zh, b.zh);
    assert.deepEqual(a.scripts, b.scripts);
}

const cases = [];
const A = ['ACHV§l Progress', 'ACHV§l 进度'], D = ['IDCARD§l Student ID', 'IDCARD§l 学生证'], P = ['Progress', '普通进度'];
for (const [order, first, second] of [['ACHV first', A, D], ['IDCARD first', D, A]]) {
    const source = prelude + fn('f1', first[0]) + fn('f2', second[0]) + fn('f3', 'Progress');
    const en = new Map([['script.ui.title', first[0]], ['script.ui.title_1', second[0]], ['script.ui.title_2', P[0]]]);
    const zh = new Map([['script.ui.title', first[1]], ['script.ui.title_1', second[1]], ['script.ui.title_2', P[1]]]);
    const achvKey = first === A ? 'script.ui.title' : 'script.ui.title_1';
    for (const [mode, existing] of [['fresh', {}], ['zh-only', { zh_CN: zh }], ['bilingual', { en_US: en, zh_CN: zh }]]) {
        cases.push([`#168 ${order} ${mode}: only the ACHV key changes; series, order and other titles stay`, async () => {
            const { base, cand } = await pair(source, { existing });
            sameExcept(base, cand, achvKey);
            const ti = first === A ? 0 : 1;
            split(cand.titles[ti], achvKey);
            assert.equal(cand.en.find(([k]) => k === achvKey)[1], 'Progress');
            if (mode !== 'fresh') assert.equal(cand.zh.find(([k]) => k === achvKey)[1], '进度');
            // 渲染后 ACHV 恰好一次，其余标题与基线渲染相同
            assert.equal(render(cand.titles[ti], cand.zh), mode === 'fresh' ? 'ACHV§l Progress' : 'ACHV§l 进度');
            assert.equal(countAchv(render(cand.titles[ti], cand.zh)), 1);
            cand.titles.forEach((t, i) => { if (i !== ti) assert.equal(render(t, cand.zh), render(base.titles[i], base.zh)); });
            assert.deepEqual(cand.warnACHV, []);
            // 运行时精确表不能登记整段（否则 M("ACHV§l Progress") 会映射到不含标记的译文）
            assert.ok(!/\["ACHV§l Progress"/.test(cand.scripts[SCRIPT]), 'reg() 不应登记 ACHV 整段');
        }]);
    }
}

// 同系列预演/正式轮的对齐：仅中文回填时同系列 ord、键分配不能被旁路
cases.push(['#168 zh-only keeps the series state (no IDCARD key drift)', async () => {
    const source = prelude + fn('f1', T) + fn('f2', I);
    const zh = new Map([['script.ui.title', A[1]], ['script.ui.title_1', D[1]]]);
    const { base, cand } = await pair(source, { existing: { zh_CN: zh } });
    assert.equal(keyOf(cand.titles[1]), 'script.ui.title_1');
    assert.equal(cand.zh.find(([k]) => k === 'script.ui.title_1')[1], 'IDCARD§l 学生证');
    assert.equal(cand.ctx._seriesState.get('script.ui.title').ord, base.ctx._seriesState.get('script.ui.title').ord);
    sameExcept(base, cand, 'script.ui.title');
}]);

// 前导格式码：旧译文不是严格的 "ACHV§l " 开头 → 整标题回退为基线行为，并给 ACHV 警告；ACHV 不重复，译文不丢
for (const lead of ['§a', '§b§l ']) {
    cases.push([`#168 legacy translation with leading ${JSON.stringify(lead)} falls back with a warning`, async () => {
        const source = prelude + fn('f1', T) + fn('f2', 'Welcome Home');
        const en = new Map([['script.ui.title', T], ['script.ui.title_1', 'Welcome Home']]);
        const zh = new Map([['script.ui.title', lead + 'ACHV§l 进度'], ['script.ui.title_1', '欢迎回家']]);
        const { base, cand } = await pair(source, { existing: { en_US: en, zh_CN: zh } });
        identical(base, cand);
        assert.equal(render(cand.titles[0], cand.zh), lead + 'ACHV§l 进度');
        assert.equal(countAchv(render(cand.titles[0], cand.zh)), 1);
        assert.ok(cand.warnACHV.length >= 1, '需要 ACHV 警告');
    }]);
}
cases.push(['#168 two legacy keys carrying ACHV: no guess, same as baseline, with a warning', async () => {
    const source = prelude + fn('f1', T) + fn('f2', I);
    for (const [existing] of [
        [{ zh_CN: new Map([['script.ui.title', 'ACHV§l 进度'], ['script.ui.title_1', 'ACHV§l 进度'], ['script.ui.title_2', D[1]]]) }],
        [{ zh_CN: new Map([['script.ui.title', 'ACHV§l 进度'], ['script.ui.title_1', 'ACHV§l 成就'], ['script.ui.title_2', D[1]]]) }],
        [{ en_US: new Map([['script.ui.title', T], ['script.ui.title_1', T], ['script.ui.title_2', I]]), zh_CN: new Map([['script.ui.title', 'ACHV§l 进度'], ['script.ui.title_1', 'ACHV§l 成就'], ['script.ui.title_2', D[1]]]) }],
    ]) {
        const { base, cand } = await pair(source, { existing });
        identical(base, cand);
        assert.ok(cand.warnACHV.length >= 1);
    }
}]);

// 已迁移输出再次转换：幂等，沿用同一键
cases.push(['#168 converting the migrated output again keeps keys and split', async () => {
    const source = prelude + fn('f1', T) + fn('f2', I);
    const first = await convert(source, { achv: true });
    const second = await convert(source, { achv: true, existing: { en_US: new Map(first.en.filter(([k]) => /^script\.ui\./.test(k))), zh_CN: new Map(first.zh.filter(([k]) => /^script\.ui\./.test(k))) } });
    split(second.titles[0], 'script.ui.title');
    assert.equal(keyOf(second.titles[1]), 'script.ui.title_1');
    assert.deepEqual(second.en.filter(([k]) => /^script\.ui\./.test(k)), first.en.filter(([k]) => /^script\.ui\./.test(k)));
}]);

// 跨脚本
const otherAction = prelude + fn('g1', T);
cases.push(['#168 cross-script: same ACHV title in two Action forms shares one key and splits both', async () => {
    const source = prelude + fn('f1', T) + fn('f2', I);
    const { base, cand } = await pair(source, { extra: { 'BP/scripts/other.js': otherAction } });
    sameExcept(base, cand, 'script.ui.title');
    split(cand.titles[0], 'script.ui.title');
    assert.ok(cand.scripts['BP/scripts/other.js'].includes('"translate":"script.ui.title"') && cand.scripts['BP/scripts/other.js'].includes('"text":"ACHV"'));
}]);
cases.push(['#168 cross-script: other script uses the text as a plain message → no split, identical to baseline', async () => {
    const source = prelude + fn('f1', T) + fn('f2', I);
    const { base, cand } = await pair(source, { extra: { 'BP/scripts/other.js': prelude + msg('m1', T) } });
    identical(base, cand);
}]);
cases.push(['#168 cross-script: other script uses it in a Modal title → no split, identical to baseline', async () => {
    const modal = 'import { ModalFormData } from "@minecraft/server-ui";\nexport function h(p){const gui = new ModalFormData(); gui.title(' + JSON.stringify(T) + '); return gui.show(p);}\n';
    const source = prelude + fn('f1', T) + fn('f2', I);
    const { base, cand } = await pair(source, { extra: { 'BP/scripts/other.js': modal } });
    identical(base, cand);
}]);
cases.push(['#168 cross-script: same text as an old key of another script is not claimed', async () => {
    const source = prelude + fn('f1', T) + fn('f2', I);
    const en = new Map([['script.other.title', T], ['script.ui.title', T], ['script.ui.title_1', I]]);
    const zh = new Map([['script.other.title', 'ACHV§l 另一个'], ['script.ui.title', A[1]], ['script.ui.title_1', D[1]]]);
    const { base, cand } = await pair(source, { existing: { en_US: en, zh_CN: zh }, extra: { 'BP/scripts/other.js': otherAction } });
    sameExcept(base, cand, 'script.ui.title');
    assert.equal(new Map(cand.zh).get('script.other.title'), new Map(base.zh).get('script.other.title'));
}]);

// 同一文字同时用作标题和普通消息：保持原有去重和键分配
for (const [name, source] of [
    ['title then message', prelude + fn('f1', T) + msg('m1', T) + fn('f2', I)],
    ['message then title', prelude + msg('m1', T) + fn('f1', T) + fn('f2', I)],
]) {
    for (const [mode, existing] of [['fresh', {}], ['zh-only', { zh_CN: new Map([['script.ui.title', A[1]], ['script.ui.title_1', D[1]]]) }]]) {
        cases.push([`#168 shared text (${name}, ${mode}) keeps baseline dedupe and key allocation`, async () => {
            const { base, cand } = await pair(source, { existing });
            identical(base, cand);
        }]);
    }
}

// 非目标：普通标题、带颜色码前缀的普通标题、ACHVement、其他路由标记标题
cases.push(['#168 ordinary titles, ACHVement and other routing markers are unchanged', async () => {
    const source = prelude + fn('a', 'Progress') + fn('b', '§aShop §lMenu') + fn('c', 'ACHVement unlocked') + fn('d', I) + fn('e', 'TITLE§l Main') + fn('f', 'ACHT§l Stats') + fn('g', 'CHEAT§l Admin');
    const { base, cand } = await pair(source);
    identical(base, cand);
}]);
cases.push(['#168 ACHV marker with source-side leading color code or trailing code is not split', async () => {
    const source = prelude + fn('a', '§aACHV§l Progress') + fn('b', 'ACHV§l Progress§r');
    const { base, cand } = await pair(source);
    identical(base, cand);
}]);

// 接收者无法确认是原生 ActionFormData → 保守不拆
cases.push(['#168 unconfirmed receiver (parameter / rebound name) is not split', async () => {
    const viaParam = prelude + 'export function f(gui, p) {\n  gui.title(' + JSON.stringify(T) + ');\n  return gui.show(p);\n}\n';
    const rebound = prelude + 'export function f(p, mk) {\n  let gui = new ActionFormData();\n  gui = mk();\n  gui.title(' + JSON.stringify(T) + ');\n  return gui.show(p);\n}\n';
    const shadowed = prelude + 'export function f(p) {\n  for (const ActionFormData = Object; ; ) {\n    const gui = new ActionFormData();\n    gui.title(' + JSON.stringify(T) + ');\n    return gui.show(p);\n  }\n}\n';
    for (const source of [viaParam, rebound, shadowed]) {
        const { base, cand } = await pair(source);
        identical(base, cand);
    }
}]);
cases.push(['#168 chained and reassigned-to-new Action form receivers are recognised', async () => {
    const source = prelude + 'export function f(p) {\n  let gui = new ActionFormData();\n  gui = new ActionFormData();\n  gui.title(' + JSON.stringify(T) + ');\n  return gui.show(p);\n}\n';
    const { cand } = await pair(source);
    split(cand.titles[0], 'script.ui.title');
}]);

// 运行时回放：生成的 rawtext 用 lang 渲染后是 ACHV + §l + 可见译文；__i18n.M(整段) 不会映射到无标记译文
cases.push(['#168 runtime replay: whole-marker text is not remapped; rawtext renders ACHV once', async () => {
    const source = prelude + fn('f1', T) + 'export function s(p, x) { p.sendMessage(x); }\n';
    const { base, cand } = await pair(source, { existing: { zh_CN: new Map([['script.ui.title', A[1]]]) } });
    const replay = (text) => {
        const rtName = /const (__i18n\w*) = /.exec(text)[1];
        const runnable = text.replace(/^import .*$/gm, '').replace(/\bexport\s+(?=function|const)/g, '');
        return vm.runInNewContext(runnable + '\n' + rtName + '.M(' + JSON.stringify(T) + ');', {}, { timeout: 2000 });
    };
    // 基线登记了整段（M 会返回 { rawtext:[translate] }）；候选没有登记，M 原样返回原文，ACHV 标记不会被译文替换
    assert.notEqual(replay(base.scripts[SCRIPT]), T);
    assert.equal(replay(cand.scripts[SCRIPT]), T);
    assert.equal(render(cand.titles[0], cand.zh), 'ACHV§l 进度');
    assert.equal(countAchv(render(cand.titles[0], cand.zh)), 1);
}]);
// ---- PR #184 独立复审（Codex）第二轮的两个 P2 反例 ----
// 脚本里所有 rawtext 显示调用（title / sendMessage）用 zh 读回后的实际文字
const shown = (script, zh) => {
    const m = new Map(zh);
    return [...script.matchAll(/(?:title|sendMessage)\((\{"rawtext":\[.*?\]\})\)/g)].map(x => JSON.parse(x[1]).rawtext.map(n => n.text ?? m.get(n.translate) ?? '<' + n.translate + '>').join(''));
};
const withPlayer = (body) => prelude + 'export function a(player) {\n  const gui = new ActionFormData();\n' + body + '  return gui.show(player);\n}\n';

// 旧版译文夹具：取基线（main 行为）在 fresh 下实际生成的 script.ui.* 键值，按原文换成中文。这样夹具与源码顺序一致，不是凭空编的键
const ZH = new Map([[T, A[1]], ['Progress', '普通进度'], [I, D[1]]]);
async function oldLangs(source) {
    const fresh = await convert(source, { achv: false });
    const en = new Map(fresh.en.filter(([k]) => /^script\.ui\./.test(k)));
    const zh = new Map([...en].map(([k, v]) => [k, ZH.get(v) ?? v]));
    return { en, zh };
}
const MODES = (old) => [['fresh', {}], ['bilingual', { en_US: old.en, zh_CN: old.zh }], ['zh-only', { zh_CN: old.zh }]];

// P2-1：整段文字也以静态拼接用于消息。提取器把 "ACHV§l " + "Progress" 当作同一段文字，与标题共用一个键 → 不能只拆标题
for (const [order, body] of [
    ['title then concat message', '  gui.title("ACHV§l Progress");\n  player.sendMessage("ACHV§l " + "Progress");\n'],
    ['concat message then title', '  player.sendMessage("ACHV§l " + "Progress");\n  gui.title("ACHV§l Progress");\n'],
    ['title then three-piece concat message', '  gui.title("ACHV§l Progress");\n  player.sendMessage("ACHV" + "§l " + "Progress");\n'],
    ['title then concat message with trailing §r (Codex round 2)', '  gui.title("ACHV§l Progress");\n  player.sendMessage("ACHV§l " + "Progress§r");\n'],
    ['concat message with trailing §r then title', '  player.sendMessage("ACHV§l " + "Progress§r");\n  gui.title("ACHV§l Progress");\n'],
    ['title then concat message with leading colour code', '  gui.title("ACHV§l Progress");\n  player.sendMessage("§a" + "ACHV§l " + "Progress");\n'],
    ['title then plain message with trailing §r', '  gui.title("ACHV§l Progress");\n  player.sendMessage("ACHV§l Progress§r");\n'],
]) {
    cases.push([`#184 P2-1 ${order}: shared text keeps baseline key and translation in all modes`, async () => {
        const source = withPlayer(body);
        const old = await oldLangs(source);
        assert.equal(old.en.size, 1, '前提：基线里标题和消息共用一个键');
        for (const [mode, existing] of MODES(old)) {
            const { base, cand } = await pair(source, { existing });
            identical(base, cand);
            const out = shown(cand.scripts[SCRIPT], cand.zh);
            // 标题和消息读回的文字与基线逐项相同（消息可能带前导/尾部格式码）；有旧译文时两处都是中文，消息不回退英文
            assert.deepEqual(out, shown(base.scripts[SCRIPT], base.zh), mode + ': 读回与基线相同');
            if (mode !== 'fresh') out.forEach(s => assert.ok(s.includes('进度'), mode + ': ' + s));
            out.forEach(s => assert.equal(countAchv(s), 1));
            assert.deepEqual(cand.warnACHV, []);
        }
    }]);
}
// 对照：消息模板里带插值（${…}）时提取器给它独立的带参数键，不与标题共用 → 标题照常拆分，消息与基线相同
cases.push(['#184 P2-1 control: template message with an interpolation does not share the title key', async () => {
    const source = withPlayer('  gui.title("ACHV§l Progress");\n  player.sendMessage(`ACHV§l ${"Progress"}`);\n');
    const { base, cand } = await pair(source);
    sameExcept(base, cand, 'script.ui.title');
    split(cand.titles[0], 'script.ui.title');
    const msgLine = (s) => s.split('\n').find(l => l.includes('player.sendMessage(')).replace(/^.*?player\.sendMessage\(/, '');
    assert.equal(msgLine(cand.scripts[SCRIPT]), msgLine(base.scripts[SCRIPT]));
}]);

// P2-2：ACHV 标题与普通 "Progress" 标题共存。普通标题的旧键只能由普通标题使用
const achvAndPlain = (achvFirst) => prelude + (achvFirst ? fn('a', T) + fn('b', 'Progress') : fn('b', 'Progress') + fn('a', T));
for (const achvFirst of [true, false]) {
    const order = achvFirst ? 'ACHV first' : 'plain first';
    const ai = achvFirst ? 0 : 1, pi = 1 - ai;
    // Codex 的原始反例：只有普通标题的旧键 title_1（en=Progress，zh=普通进度）
    const plainOnly = { en: new Map([['script.ui.title_1', 'Progress']]), zh: new Map([['script.ui.title_1', '普通进度']]) };
    for (const [mode, existing] of MODES(plainOnly)) {
        cases.push([`#184 P2-2 ${order} (${mode}, only the plain title_1 old key): ACHV does not take it`, async () => {
            const { base, cand } = await pair(achvAndPlain(achvFirst), { existing });
            const achvKey = keyOf(base.titles[ai]);
            assert.equal(keyOf(cand.titles[pi]), keyOf(base.titles[pi]), '普通标题的键与基线相同');
            assert.equal(render(cand.titles[pi], cand.zh), render(base.titles[pi], base.zh), '普通标题读回的译文与基线相同');
            if (mode === 'bilingual' && achvFirst) assert.equal(render(cand.titles[pi], cand.zh), '普通进度');
            sameExcept(base, cand, achvKey);
            split(cand.titles[ai], achvKey);
            assert.notEqual(keyOf(cand.titles[ai]), keyOf(cand.titles[pi]));
            assert.equal(render(cand.titles[ai], cand.zh), render(base.titles[ai], base.zh));
            assert.equal(countAchv(render(cand.titles[ai], cand.zh)), 1);
        }]);
    }
    // 基线自己生成的两个旧键（顺序与源码一致）都放回：各自沿用、各自的译文读回
    cases.push([`#184 P2-2 ${order} (both old keys from the baseline output): each title keeps its own key`, async () => {
        const source = achvAndPlain(achvFirst);
        const old = await oldLangs(source);
        for (const [mode, existing] of MODES(old)) {
            const { base, cand } = await pair(source, { existing });
            const achvKey = keyOf(base.titles[ai]);
            assert.equal(keyOf(cand.titles[ai]), achvKey, mode);
            assert.equal(keyOf(cand.titles[pi]), keyOf(base.titles[pi]), mode);
            split(cand.titles[ai], achvKey);
            sameExcept(base, cand, achvKey);
            if (mode !== 'fresh') {
                assert.equal(render(cand.titles[ai], cand.zh), A[1], mode);
                assert.equal(render(cand.titles[pi], cand.zh), '普通进度', mode);
            }
        }
    }]);
}
// 无法唯一确认：旧 lang 的 title 系列键数与这个文件的 title 种数对不上 → 不按位置认领，按旧版同参数分配整段；
// 认到已有键就保持整段并警告，得到全新键才拆分
cases.push(['#184 P2-2 old title series that does not match the title count: no guess, baseline key kept, warning', async () => {
    const zh = new Map([['script.ui.title', '§l成就进度'], ['script.ui.title_1', '普通进度'], ['script.ui.title_2', '多出来的旧键']]);
    const { base, cand } = await pair(achvAndPlain(true), { existing: { zh_CN: zh } });
    assert.equal(keyOf(base.titles[0]), 'script.ui.title', '前提：基线把整段认给了已有键');
    identical(base, cand);
    assert.ok(cand.warnACHV.length >= 1);
}]);
// 旧 lang 的 title 系列键数与 title 种数相同，但旧值和标题文字对不上（旧键 title 的译文是"§l成就进度"，不像"Progress"的译文）：
// 即使数量吻合也不能按位置认领 → 与基线相同并警告（最初的回归断言，原样保留）
cases.push(['#184 P2-2 unconfirmed old key with a contested visible text falls back to baseline with a warning', async () => {
    const zh = new Map([['script.ui.title', '§l成就进度'], ['script.ui.title_1', '普通进度']]);
    const { base, cand } = await pair(achvAndPlain(true), { existing: { zh_CN: zh } });
    assert.equal(keyOf(base.titles[0]), 'script.ui.title', '前提：基线把整段认给了已有键');
    identical(base, cand);
    assert.ok(cand.warnACHV.length >= 1);
}]);cases.push(['#184 P2-2 old title series larger than the title count: no guess, baseline key kept, warning', async () => {
    const zh = new Map([['script.ui.title', '§l成就进度'], ['script.ui.title_1', '普通进度'], ['script.ui.title_2', '多出来的旧键']]);
    const { base, cand } = await pair(achvAndPlain(true), { existing: { zh_CN: zh } });
    identical(base, cand);
    assert.ok(cand.warnACHV.length >= 1);
}]);
cases.push(['#184 P2-2 two ACHV-shaped old keys next to a plain Progress title: no guess', async () => {
    const zh = new Map([['script.ui.title', A[1]], ['script.ui.title_1', 'ACHV§l 成就'], ['script.ui.title_2', '普通进度']]);
    const { base, cand } = await pair(achvAndPlain(true), { existing: { zh_CN: zh } });
    identical(base, cand);
    assert.ok(cand.warnACHV.length >= 1);
}]);

// ---- PR #184 第三轮 P2-2：把上一轮输出的 lang 反复放回同一份原始脚本（至少五轮），逐轮核对键名、译文归属和有序语言文件 ----
// roles：每个标题的角色 A=ACHV 标题 P=普通 Progress I=IDCARD 标题。首轮输出后按角色"翻译"一次，之后每轮只放回上一轮的输出
const ROLE_ZH = { A: ['进度', 'ACHV§l 进度'], P: ['普通进度', '普通进度'], I: ['IDCARD§l 学生证', 'IDCARD§l 学生证'] };
const uiOnly = (arr) => arr.filter(([k]) => /^script\.ui\./.test(k));
async function reconvert(source, roles, mode, achv, rounds = 5) {
    const snaps = [];
    let cur = await convert(source, { achv });
    const isSplit = (t) => typeof t !== 'string' && t.rawtext.some(n => n.text === 'ACHV');
    let zh = new Map(uiOnly(cur.zh)), en = new Map(uiOnly(cur.en));
    cur.titles.forEach((t, i) => zh.set(keyOf(t), ROLE_ZH[roles[i]][isSplit(t) ? 0 : 1]));
    for (let r = 1; r <= rounds; r++) {
        const existing = mode === 'bilingual' ? { en_US: en, zh_CN: zh } : { zh_CN: zh };
        cur = await convert(source, { achv, existing });
        snaps.push({
            refs: cur.titles.map(keyOf), shown: cur.titles.map(t => render(t, cur.zh)),
            en: uiOnly(cur.en), zh: uiOnly(cur.zh), warn: cur.warnACHV.length,
        });
        en = new Map(uiOnly(cur.en)); zh = new Map(uiOnly(cur.zh));
    }
    return snaps;
}
const RERUNS = [
    ['ACHV + plain Progress', 'AP', prelude + fn('a', T) + fn('b', 'Progress')],
    ['plain Progress + ACHV', 'PA', prelude + fn('b', 'Progress') + fn('a', T)],
    ['ACHV + IDCARD + plain Progress', 'AIP', prelude + fn('a', T) + fn('c', I) + fn('b', 'Progress')],
    ['IDCARD + plain Progress + ACHV', 'IPA', prelude + fn('c', I) + fn('b', 'Progress') + fn('a', T)],
    ['ACHV + IDCARD (no plain Progress)', 'AI', prelude + fn('a', T) + fn('c', I)],
    ['ACHV alone', 'A', prelude + fn('a', T)],
];
for (const [name, roles, source] of RERUNS) {
    for (const mode of ['bilingual', 'zh-only']) {
        cases.push([`#184 P2-2 five rounds of re-feeding the previous output (${name}, ${mode}): keys, translations and ordered lang stay put`, async () => {
            const cand = await reconvert(source, roles, mode, true);
            const base = await reconvert(source, roles, mode, false);
            for (let r = 0; r < cand.length; r++) {
                const c = cand[r], b = base[r], tag = `round ${r + 1}`;
                // 标题引用的键：与基线逐轮相同（基线本身是稳定的）
                assert.deepEqual(c.refs, b.refs, tag + ': title keys vs baseline');
                // 每个标题读回的译文属于它自己的角色（ACHV 恰好一次，普通标题不拿成就译文）
                c.shown.forEach((s, i) => {
                    const want = { A: 'ACHV§l 进度', P: '普通进度', I: 'IDCARD§l 学生证' }[roles[i]];
                    assert.equal(s, want, `${tag}: title #${i} (${roles[i]})`);
                    if (roles[i] === 'A') assert.equal(countAchv(s), 1, tag);
                });
                // 有序语言文件：键序与基线相同；除 ACHV 键的值以外各键值与基线相同；每轮都与第 1 轮完全相同（没有逐轮漂移）
                assert.deepEqual(c.en.map(([k]) => k), b.en.map(([k]) => k), tag + ': en key order vs baseline');
                assert.deepEqual(c.zh.map(([k]) => k), b.zh.map(([k]) => k), tag + ': zh key order vs baseline');
                const achvKey = c.refs[roles.indexOf('A')];
                const strip = (arr) => arr.filter(([k]) => k !== achvKey);
                assert.deepEqual(strip(c.en), strip(b.en), tag + ': non-ACHV en');
                assert.deepEqual(strip(c.zh), strip(b.zh), tag + ': non-ACHV zh');
                assert.deepEqual(c, cand[0], tag + ': identical to round 1');
                assert.equal(c.warn, 0, tag + ': no ACHV warning on a clean re-feed');
            }
        }]);
    }
}
async function runAchvRegressions() {
    const results = [];
    for (const [name, run] of cases) {
        try { await run(); results.push({ name }); } catch (error) { results.push({ name, error }); }
    }
    return results;
}
if (require.main === module) {
    runAchvRegressions().then(results => {
        for (const { name, error } of results) console.log(error ? 'FAIL ' + name + '\n' + error.message : 'PASS ' + name);
        process.exitCode = results.some(r => r.error) ? 1 : 0;
    });
}
module.exports = { runAchvRegressions };
