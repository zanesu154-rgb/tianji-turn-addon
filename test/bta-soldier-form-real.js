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

async function replay(files, locale, owned, clientLocale) {
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
    if (clientLocale) player.clientSystemInfo = { locale: clientLocale };
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
    const templates = [
        ['script.lang.str_1', 8], ['script.lang.str_27', 1], ['script.lang.str_28', 1],
        ['script.lang_ext.str_13', 3], ['script.lang_ext.str_14', 1],
    ];
    const cases = [
        { name: 'explicit-en', author: 'en', game: 'en_US' },
        { name: 'explicit-es', author: 'es', game: 'es_ES' },
        { name: 'author-es/game-en', author: 'es', game: 'en_US' },
        { name: 'default-es/game-en', game: 'en_US' },
        { name: 'author-es/game-zh', author: 'es', game: 'zh_CN' },
        { name: 'owned-en', author: 'en', game: 'en_US', owned: true },
        { name: 'owned-es/game-en', author: 'es', game: 'en_US', owned: true },
        { name: 'owned-es/game-zh', author: 'es', game: 'zh_CN', owned: true },
    ];
    const authored = await Promise.all(cases.map(c => replay(original, c.author, c.owned)));
    const modes = [
        { name: 'fresh', languages: [] },
        { name: 'bilingual', languages: ['en_US', 'zh_CN'], translated: true },
        { name: 'zh-only', languages: ['zh_CN'], translated: true },
        { name: 'export-bilingual', seed: 'bilingual', languages: ['en_US', 'zh_CN'], translated: true },
        { name: 'export-zh-only', seed: 'bilingual', languages: ['zh_CN'], translated: true },
        { name: 'fresh-export-bilingual', seed: 'fresh', languages: ['en_US', 'zh_CN'] },
        { name: 'fresh-export-zh-only', seed: 'fresh', languages: ['zh_CN'] },
        { name: 'english-override', languages: ['en_US', 'zh_CN'], translated: true, english: true },
        { name: 'full', seed: 'bilingual', languages: [], translated: true },
    ];
    const feedbackFiles = new Map();
    const englishBody = 'English briefing: §l%1§r.\\n\\nWear the §l%1§r kit.';
    const englishClose = 'Close this briefing';
    for (const mode of modes) {
        if (flag && (mode.seed || mode.english)) continue;
        const source = mode.seed ? feedbackFiles.get(mode.seed) : historical;
        const mem = new MemFS(mode.name === 'full' ? source : original);
        for (const folder of ['behavior_packs/B/texts/', texts]) for (const lang of mode.languages) {
            const file = folder + lang + '.lang';
            mem.writeBytes(file, source.get(file));
        }
        if (mode.english) {
            // Model two explicit translated entries. Sample archives and the other modes remain byte-for-byte inputs.
            const file = texts + 'en_US.lang';
            const lang = String(mem.files.get(file))
                .replace(/^script\.lang\.str_27=.*$/m, () => 'script.lang.str_27=' + englishBody)
                .replace(/^script\.lang\.str_13=.*$/m, () => 'script.lang.str_13=' + englishClose);
            mem.writeText(file, lang);
        }
        await NS.runWorldPipeline(mem, { targetLangs: ['en_US', 'zh_CN'] });
        if (mode.name === 'fresh' || mode.name === 'bilingual') feedbackFiles.set(mode.name, mem.files);
        const modules = [...mem.files].filter(([file]) => /\.m?js$/i.test(file));
        const errors = [];
        for (const [file, source] of modules) try { parse(String(source)); } catch (error) { errors.push([file, error.message]); }
        const tables = new Map(['en_US', 'es_ES', 'zh_CN'].map(locale =>
            [locale, NS.parseLang(String(mem.files.get(texts + locale + '.lang')))]));
        if (!flag) {
            assert.equal(modules.length, 100);
            assert.deepEqual(errors, []);
            for (const [key, count] of templates) {
                for (const table of tables.values()) {
                    const indices = [...new Set([...table.get(key).matchAll(/%(\d+)\$s/g)].map(m => Number(m[1])))];
                    assert.deepEqual(indices.sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1), key);
                }
            }
        }
        const resolveForm = (form, locale) => {
            const keys = [];
            const text = [render(form.heading, tables.get(locale), keys), render(form.description, tables.get(locale), keys),
                render(form.buttons[0][0], tables.get(locale), keys), form.buttons[0][1]];
            return { text, keys: [...new Set(keys)], raw: form };
        };
        const results = [];
        for (const [i, test] of cases.entries()) {
            const expected = authored[i];
            // BTA6's declared @minecraft/server 2.6.0 cannot expose clientSystemInfo.locale.
            const native = resolveForm(await replay(mem.files, test.author, test.owned), test.game);
            if (!flag) {
                const modern = resolveForm(await replay(mem.files, test.author, test.owned, test.game), test.game);
                assert.deepEqual(modern.text, native.text, mode.name + ' / ' + test.name);
                assert.equal(native.text[3], expected.buttons[0][1]);
                if (mode.translated && test.game === 'zh_CN') {
                    assert.equal(modern.raw.buttons[0][0].translate, 'script.lang.str_13');
                    assert.equal(native.raw.buttons[0][0].translate, 'script.lang.str_13.lfmc_form_' + test.author);
                    assert.equal(native.text[2], '关闭');
                    if (test.owned) {
                        for (const key of ['script.lang.str_1', 'script.lang.str_28', 'script.lang_ext.str_13', 'script.lang_ext.str_14']) {
                            assert.ok(modern.keys.includes(key), key);
                        }
                        assert.equal(native.text[0], '§4[TRR]§r Echo-17');
                        for (const parameter of ['§6[III]§r', '7 击杀', 'Alex', '12']) assert.ok(native.text[1].includes(parameter), parameter);
                    } else {
                        assert.equal(native.text[0], '§4[TRR]§r 士兵');
                        assert.equal(native.text[1].match(/恐怖分子/g)?.length, 2);
                        assert.deepEqual(modern.raw.description, { translate: 'script.lang.str_27',
                            with: { rawtext: [{ translate: 'script.lang_ext.str' }] } });
                    }
                } else if (mode.english && test.game === 'en_US') {
                    assert.equal(native.text[2], englishClose);
                    assert.equal(modern.raw.buttons[0][0].translate, 'script.lang.str_13');
                    if (!test.owned) assert.ok(native.text[1].startsWith('English briefing: §l§4' +
                        (test.author === 'en' ? 'TERRORISTS' : 'TERRORISTAS')));
                } else {
                    assert.deepEqual(native.text.slice(1), [expected.description, ...expected.buttons[0]], mode.name + ' / ' + test.name);
                    assert.equal(modern.raw.buttons[0][0].translate, undefined);
                    if (test.owned) assert.equal(native.text[0], '§4[TRR]§r Echo-17');
                }
            }
            results.push({ scenario: test.name, ...native });
        }
        const lang = Object.fromEntries([...mem.files].filter(([f]) => f.endsWith('.lang'))
            .map(([f, text]) => [f, checksum(text)]));
        console.log(JSON.stringify({ mode: mode.name, modules: modules.length, errors, results, lang }));
    }
    assert.equal(checksum(fs.readFileSync(sample)), checksum(bytes));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
