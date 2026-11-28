// node test/bta-soldier-form-real.js ORIGINAL.mcworld HISTORICAL.zip [--observe CHECKOUT]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const Zip = require('../vendor/jszip.min');

const scripts = 'behavior_packs/B/scripts/bod/sando/';
const texts = 'resource_packs/R/texts/';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = source => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const bindings = (source, names, extra = () => false) => parse(source).body.flatMap(node => {
    const decl = node.declaration ?? node;
    const text = source.slice(decl.start, decl.end);
    return names.includes(decl.id?.name) || decl.declarations?.some(item => names.includes(item.id.name)) || extra(decl, text)
        ? [text] : [];
}).join('\n');

function prelude(source) {
    const start = source.indexOf('// ---- i18n runtime (auto-generated) ----');
    return start < 0 ? '' : source.slice(start, source.indexOf('// ---- end i18n runtime ----', start));
}

async function replay(files, locale, owned) {
    let interact, shown;
    const scheduled = [];
    class ActionFormData {
        constructor() { this.buttons = []; }
        title(value) { this.heading = value; return this; }
        body(value) { this.description = value; return this; }
        button(value, icon) { this.buttons.push([value, icon]); return this; }
        async show(player) {
            assert.equal(player.id, 'visitor');
            shown = { heading: this.heading, description: this.description, buttons: this.buttons };
            return { canceled: false, selection: 0 };
        }
    }
    const system = { currentTick: 0, run(fn) { scheduled.push(fn); } };
    const world = { beforeEvents: { playerInteractWithEntity: { subscribe(fn) { interact = fn; } } } };
    const player = { id: 'visitor', isValid: true, hasTag: key => owned && key === 'sando_team_terrorist',
        getDynamicProperty: key => key === 'sando:lang' ? locale : undefined };
    const properties = owned ? { 'sando:kills': 7, 'sando:owner': 'other', 'sando:owner_name': 'Alex', 'sando:callsign': 'Echo-17' } : {};
    const soldier = { id: 'soldier', typeId: 'sando:terrorist_soldier', isValid: true,
        getProperty: () => 0, getDynamicProperty: key => properties[key],
        getComponent: () => ({ effectiveMax: 36, currentValue: 30 }), setProperty() {} };
    const env = vm.createContext({ system, world, ActionFormData });
    const read = name => String(files.get(scripts + name));
    const lang = read('lang.js'), ext = read('ext/lang_ext.js'), war = read('warfare.js'), ranks = read('ext/ranks.js');
    const modules = [
        prelude(lang), bindings(lang, ['STR']),
        '{' + prelude(ext) + '\n' + bindings(ext, ['EXT'], (node, text) =>
            node.type === 'ForOfStatement' && text.includes('Object.assign(STR')) + '}',
        '{' + prelude(war) + '\n' + bindings(war, [
            'hooks', 'WEAPONS', 'TEAMS', 'SOLDIER_TYPES', 'now', 'valid', 'psound', 'getLang', 'tr', 'fmt', 'R', 'LF',
            'getProp', 'setProp', 'dp', 'health', 'soldierTeam', 'playerTeam', 'soldierName', 'ownerId',
            'states', 'st', 'salute', 'statusMessage', 'UI', 'openSoldierMenu',
        ], (node, text) => node.type === 'ExpressionStatement' && text.startsWith('world.beforeEvents.playerInteractWithEntity.subscribe(')) +
        '\nglobalThis.W = { hooks, dp, tr }; }',
        '{' + prelude(ranks) + '\n' + bindings(ranks, ['RANK_AT', 'BADGE', 'rankOf'], (node, text) =>
            node.type === 'ExpressionStatement' && /^W\.hooks\.(nameBadge|statusExtra) =/.test(text)) + '}',
    ];
    vm.runInContext(modules.join('\n'), env, { timeout: 2000 });
    const event = { player, target: soldier, cancel: false };
    interact(event);
    assert.equal(event.cancel, true);
    assert.equal(scheduled.length, 1);
    scheduled.shift()();
    await Promise.resolve();
    assert.ok(shown, 'native ActionFormData.show');
    return JSON.parse(JSON.stringify(shown));
}

function render(value, lang, keys) {
    if (typeof value === 'string') return value;
    if (value.rawtext) return value.rawtext.map(node => render(node, lang, keys)).join('');
    if (typeof value.text === 'string') return value.text;
    keys.push(value.translate);
    assert.ok(lang.has(value.translate), value.translate);
    const args = value.with?.rawtext || value.with || [];
    return lang.get(value.translate).replaceAll('\\n', '\n')
        .replace(/%(\d+)\$s/g, (_, i) => render(args[Number(i) - 1], lang, keys));
}

async function readArchive(bytes) {
    const zip = await Zip.loadAsync(bytes);
    return new Map(await Promise.all(Object.values(zip.files).filter(e => !e.dir)
        .map(async e => [e.name, await e.async('nodebuffer')])));
}

async function main() {
    const [sample, feedback, flag, checkout] = process.argv.slice(2);
    assert.ok(sample && feedback && (!flag || flag === '--observe' && checkout));
    const { NS, MemFS } = flag ? require(path.resolve(checkout, 'test/load')) : require('./load');
    const bytes = fs.readFileSync(sample);
    const [original, historical] = await Promise.all([readArchive(bytes), readArchive(fs.readFileSync(feedback))]);
    for (const root of ['behavior_packs/B', 'resource_packs/R']) {
        assert.deepEqual(JSON.parse(String(original.get(root + '/manifest.json'))).header.version, [2, 7, 0]);
    }
    const cases = [['en', false], ['es', false], ['en', true]];
    const authored = await Promise.all(cases.map(args => replay(original, ...args)));
    let bilingual;
    for (const [mode, languages] of [['fresh', []], ['bilingual', ['en_US', 'zh_CN']], ['zh-only', ['zh_CN']],
        ['export-bilingual', ['en_US', 'zh_CN']], ['export-zh-only', ['zh_CN']]]) {
        if (flag && mode.startsWith('export-')) continue;
        const mem = new MemFS(original);
        const input = mode.startsWith('export-') ? bilingual : historical;
        for (const folder of ['behavior_packs/B/texts/', texts]) for (const language of languages) {
            const file = folder + language + '.lang';
            mem.writeBytes(file, input.get(file));
        }
        await NS.runWorldPipeline(mem, { targetLangs: ['en_US', 'zh_CN'] });
        if (mode === 'bilingual') bilingual = mem.files;
        const modules = [...mem.files].filter(([file]) => /\.m?js$/i.test(file));
        const errors = [];
        for (const [file, source] of modules) try { parse(String(source)); } catch (error) { errors.push([file, error.message]); }
        if (!flag) {
            assert.equal(modules.length, 100);
            assert.deepEqual(errors, []);
        }
        const captured = await Promise.all(cases.map(args => replay(mem.files, ...args)));
        const table = locale => NS.parseLang(String(mem.files.get(texts + locale + '.lang')));
        const results = captured.map((form, i) => {
            const [language, owned] = cases[i];
            const keys = [];
            const resolve = (value, locale) => render(value, table(locale), keys);
            const source = language === 'es' ? 'es_ES' : 'en_US';
            const plain = locale => [resolve(form.heading, locale), resolve(form.description, locale),
                resolve(form.buttons[0][0], locale), form.buttons[0][1]];
            const sourceText = plain(source);
            const target = plain('zh_CN');
            if (!flag) {
                const expected = authored[i];
                assert.deepEqual(sourceText, [expected.heading, expected.description, ...expected.buttons[0]]);
                const close = form.buttons[0][0];
                assert.equal(close.translate, 'script.lang.str_13');
                if (!owned) {
                    assert.equal(form.description.translate, 'script.lang.str_27');
                    assert.deepEqual(form.description.with.rawtext, [{ translate: 'script.lang_ext.str' }]);
                    assert.ok(keys.includes('script.warfare.str_37'));
                    if (mode !== 'fresh') {
                        assert.equal(target[0], '§4[TRR]§r 士兵');
                        assert.equal(target[1].match(/恐怖分子/g)?.length, 2);
                    }
                } else {
                    assert.ok(keys.includes('script.lang.str_1') && keys.includes('script.lang_ext.str_13'));
                    assert.ok(keys.includes('script.lang.str_28') && keys.includes('script.lang_ext.str_14'));
                    assert.equal(target[0], '§4[TRR]§r Echo-17');
                    assert.ok(target[1].includes('§6[III]§r') && target[1].includes('Alex') && target[1].includes('12'));
                }
                if (mode !== 'fresh') assert.equal(target[2], '关闭');
            }
            return { sourceText, target, keys: [...new Set(keys)], raw: form };
        });
        const lang = Object.fromEntries([...mem.files].filter(([f]) => f.endsWith('.lang'))
            .map(([f, text]) => [f, checksum(text)]));
        console.log(JSON.stringify({ mode, modules: modules.length, errors, results, lang }));
    }
    assert.equal(checksum(fs.readFileSync(sample)), checksum(bytes));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
