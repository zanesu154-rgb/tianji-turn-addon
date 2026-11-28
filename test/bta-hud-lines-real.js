// node test/bta-hud-lines-real.js ORIGINAL.mcworld HISTORICAL.zip [--observe CHECKOUT]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const Zip = require('../vendor/jszip.min');

const scripts = 'behavior_packs/B/scripts/bta/';
const uiPath = 'resource_packs/R/ui/hud_screen.json';
const digest = value => createHash('sha256').update(value).digest('hex');
const parse = source => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

async function readZip(bytes) {
    const zip = await Zip.loadAsync(bytes);
    return new Map(await Promise.all(Object.values(zip.files).filter(entry => !entry.dir)
        .map(async entry => [entry.name, await entry.async('nodebuffer')])));
}

function declarations(source, names) {
    return parse(source).body.flatMap(node => {
        const decl = node.declaration ?? node;
        return names.includes(decl.id?.name) || decl.declarations?.some(item => names.includes(item.id.name))
            ? [source.slice(decl.start, decl.end)] : [];
    }).join('\n');
}

function prelude(source) {
    const start = source.indexOf('// ---- i18n runtime (auto-generated) ----');
    return start < 0 ? '' : source.slice(start, source.indexOf('// ---- end i18n runtime ----', start));
}

function replay(files) {
    const read = name => String(files.get(scripts + name + '.js'));
    const hud = read('hud'), i18n = read('i18n');
    const calls = [];
    const player = { id: 'probe', onScreenDisplay: {
        setTitle(text, options) { calls.push({ text, options }); },
        clearTitle() { calls.push({ clear: true }); },
    } };
    const state = { hud: true, map: true, debt: 0 };
    const context = vm.createContext({
        player, valid: () => true, now: () => 0,
        world: { getTimeOfDay: () => 1000, getDay: () => 0 },
        cashOf: () => 600, bankOf: () => 0, wantedOf: () => 0, seenOf: () => true,
        pget: (_, key, fallback) => key === 'set' ? { hud: state.hud } : key === 'debt' ? state.debt : fallback,
        mapEnabled: () => state.map, mapText: () => '  §a• map',
    });
    const snippets = [
        prelude(i18n), declarations(i18n, ['EN', 'ES', 'STRINGS', 'getLang', 't']),
        declarations(read('core'), ['fmt']), '{' + prelude(hud),
        declarations(hud, ['PANEL', 'clock', 'stars', 'panelText', 'renderPanel', 'pauseUntil', 'shown']),
        'globalThis.draw = () => renderPanel(player); globalThis.originalPanel = () => panelText(player); }',
    ];
    vm.runInContext(snippets.join('\n'), context, { timeout: 2000 });
    const original = [context.originalPanel()];
    context.draw();
    state.debt = 25;
    original.push(context.originalPanel());
    context.draw();
    state.map = false;
    context.draw();
    state.hud = false;
    state.map = true;
    context.draw();
    state.map = false;
    context.draw();
    return { original, calls: JSON.parse(JSON.stringify(calls)) };
}

function render(message, lang, keys) {
    if (typeof message === 'string') return message;
    if (message.rawtext) return message.rawtext.map(node => render(node, lang, keys)).join('');
    if (typeof message.text === 'string') return message.text;
    keys.push(message.translate);
    assert.ok(lang.has(message.translate), message.translate);
    const args = message.with?.rawtext || message.with || [];
    return lang.get(message.translate).replace(/%(\d+)\$s/g, (_, slot) => render(args[Number(slot) - 1], lang, keys));
}

async function main() {
    const [archive, historical, flag, checkout] = process.argv.slice(2);
    assert.ok(archive && historical && (!flag || flag === '--observe' && checkout));
    const observe = flag === '--observe';
    const { NS, MemFS } = observe ? require(path.resolve(checkout, 'test/load')) : require('./load');
    const bytes = fs.readFileSync(archive);
    const [original, feedback] = await Promise.all([readZip(bytes), readZip(fs.readFileSync(historical))]);
    for (const folder of ['behavior_packs/B', 'resource_packs/R']) {
        assert.deepEqual(JSON.parse(String(original.get(folder + '/manifest.json'))).header.version, [2, 7, 0]);
    }
    const raw = replay(original);
    assert.equal(raw.calls[0].text.split('\n').length, 5);
    assert.equal(raw.calls[1].text.split('\n').length, 6);
    for (const [mode, languages] of [['fresh', []], ['bilingual', ['en_US', 'zh_CN']], ['zh-only', ['zh_CN']]]) {
        const mem = new MemFS(original);
        for (const folder of ['behavior_packs/B/texts/', 'resource_packs/R/texts/']) for (const language of languages) {
            const file = folder + language + '.lang';
            mem.writeBytes(file, feedback.get(file));
        }
        await NS.runWorldPipeline(mem, { targetLangs: ['en_US', 'zh_CN'] });
        const { original: beforeMapping, calls } = replay(mem.files);
        assert.deepEqual(beforeMapping, raw.original);
        const scripts = [...mem.files].filter(([file]) => /\.m?js$/i.test(file));
        const errors = [];
        for (const [file, source] of scripts) {
            try { parse(String(source)); } catch (error) { errors.push([file, error.message]); }
        }
        const langHashes = Object.fromEntries([...mem.files].filter(([file]) => file.endsWith('.lang'))
            .map(([file, value]) => [file, digest(value)]));
        const lang = language => NS.parseLang(String(mem.files.get('resource_packs/R/texts/' + language + '.lang')));
        const panels = calls.slice(0, 2).map(call => {
            const keys = [], english = render(call.text, lang('en_US'), keys);
            return { english, chinese: render(call.text, lang('zh_CN'), []), keys };
        });
        assert.equal(digest(mem.files.get(uiPath)), digest(original.get(uiPath)));
        assert.deepEqual(calls.map(({ options, clear }) => options || { clear }),
            raw.calls.map(({ options, clear }) => options || { clear }));
        assert.equal(calls[3].text, '§r§r§r');
        assert.deepEqual(calls[4], { clear: true });
        if (!observe) {
            assert.equal(scripts.length, 100);
            assert.deepEqual(errors, []);
            assert.deepEqual(panels.map(panel => panel.english), raw.original);
            assert.deepEqual(calls[2].text, calls[1].text);
            for (const panel of panels) assert.ok(panel.keys.includes('script.i18n.str_985'), panel.english);
            if (mode !== 'fresh') {
                for (const panel of panels) assert.ok(panel.chinese.startsWith('§r§r§r§f07:00  §7第 1 天\n'), panel.chinese);
                assert.match(panels[1].chinese, /\n§c[^\n]+ -\$25\n/);
            }
        }
        console.log(JSON.stringify({ mode, panels, rawLines: raw.original.map(s => s.split('\n').length), scripts: scripts.length,
            errors, langHashes, hudUiHash: digest(mem.files.get(uiPath)), options: calls.map(call => call.options) }));
    }
    assert.equal(digest(fs.readFileSync(archive)), digest(bytes));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
