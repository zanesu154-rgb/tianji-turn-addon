// Synthetic reproductions of verified code-review regressions. No private inputs.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { NS, MemFS, readDir } = require('./load.js');
const { tests: classifications } = require('./review-regression-tiers.json');

const scriptPath = 'BP/scripts/achv_ui.js';
const target = 'script.achv_ui.title';
const ordinary = target + '_1';
const other = 'script.other.title';
const prefix = 'ACHV§l Progress';
const achvSource = [
    'import { ActionFormData } from "@minecraft/server-ui";',
    'export function openAchv(p) {',
    '  const gui = new ActionFormData();',
    '  gui.title("ACHV§l Progress");',
    '  return gui.show(p);',
    '}',
    'export function openOrdinary(p) {',
    '  const gui = new ActionFormData();',
    '  gui.title("Progress");',
    '  return gui.show(p);',
    '}',
].join('\n');
const route = {
    bindings: [{ binding_type: 'view', source_property_name: "(not ((#title_text - 'ACHV') = #title_text))", target_property_name: '#visible' }],
};

function langFile(entries) {
    return '## ==== addon-i18n ====\n' + [...entries].map(([k, v]) => k + '=' + v).join('\n') + '\n';
}

async function convert(ui, existing = {}, source = achvSource) {
    const files = readDir(path.join(__dirname, 'fixture'));
    files.set(scriptPath, Buffer.from(source));
    if (ui) files.set('RP/ui/server_form.json', Buffer.from(JSON.stringify(ui)));
    for (const [lang, map] of Object.entries(existing)) files.set('RP/texts/' + lang + '.lang', Buffer.from(langFile(map)));
    const mem = new MemFS(files);
    const { ctx } = await NS.runPipeline(mem, { baseName: 'fixture', targetLangs: ['en_US', 'zh_CN'], processScripts: true, injectRuntime: true }, () => {});
    const src = String(mem.files.get(scriptPath));
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    const titles = src.split('\n').filter(line => line.includes('gui.title(')).map(line => {
        const arg = line.slice(line.indexOf('gui.title(') + 'gui.title('.length, line.lastIndexOf(');'));
        return JSON.parse(arg);
    });
    return {
        titles,
        warnings: ctx.warnings,
        en: NS.parseLang(String(mem.files.get('RP/texts/en_US.lang'))),
        zh: NS.parseLang(String(mem.files.get('RP/texts/zh_CN.lang'))),
    };
}

const translateKey = title => title.rawtext?.find(node => node.translate)?.translate;
const render = (title, lang) => typeof title === 'string' ? title
    : title.rawtext.map(node => node.text ?? lang.get(node.translate)).join('');

function reviewKeys(actual, baseline) {
    for (const lang of ['en', 'zh']) {
        const withoutTarget = map => [...map].filter(([key]) => key !== target);
        assert.deepEqual(withoutTarget(actual[lang]), withoutTarget(baseline[lang]), lang + ': non-target keys, order and values');
    }
}

function ore(source, invocation, expected) {
    const ctx = new NS.ExtractContext({});
    const output = NS.processScript(source, 'BP/scripts/ore_probe.js', ctx, {
        injectRuntime: true, formSinksEnabled: true,
    }).content || source;
    acorn.parse(output, { ecmaVersion: 'latest', sourceType: 'module' });
    class Observable {
        constructor(value, options) { this.value = value; this.options = options; }
        getData() { return this.value; }
        setData(value) { this.value = value; }
    }
    class Form {
        constructor(player, title) { this.title = title; }
        label() {}
    }
    const env = { Sr: Form, zi: Observable, ORM: Observable };
    for (const [, alias] of output.matchAll(/ObservableUIRawMessage\s+as\s+(\w+)/g)) env[alias] = Observable;
    const runnable = output.replace(/^import .*$/gm, '').replace(/\bexport\s+(?=function|const)/g, '');
    assert.equal(vm.runInNewContext(runnable + '\n' + invocation, env, { timeout: 1000 }), expected);
}

const imports = 'import { CustomForm as Sr, ObservableString as zi } from "@minecraft/server-ui";\n';
const strictRecipient = '{label(v){if(typeof v.getData()!=="string") throw TypeError("string expected");}}';
const method = 'config.setup=(form)=>{const v=new zi("Hello");form.label(v);v.setData("Welcome");};';
const cases = [
    ['#169 valid import with a trailing comma', () => ore(imports.replace('zi }', 'zi, }') +
        'export function f(p){const o=new zi("Hello");return new Sr(p,o)}', 'Boolean(f({}).title)', true)],
    ['#169 trailing comma followed by comment', () => ore(imports.replace('zi }', 'zi, /* keep */ }') +
        'export function f(p){const o=new zi("Hello");return new Sr(p,o)}', 'Boolean(f({}).title)', true)],
    ['#169 helper called through an alias', () => ore(imports +
        'function build(c){const v=new zi("Hello");c.label(v);v.setData("Welcome")}\n' +
        'export function f(p, fake){build(new Sr(p,"Title")); const other=build; other(fake);}',
    'f({},' + strictRecipient + '); true', true)],
    ['#169 spread constructor retains clientWritable', () => ore(imports +
        'export function f(p,it){const o=new zi(...it);return new Sr(p,o)}',
    'f({},["Hello",{clientWritable:true}]).title.options.clientWritable', true)],
    ['#169 existing import alias shadowed by parameter', () => ore(imports.replace('zi }', 'zi, ObservableUIRawMessage as ORM }') +
        'export function f(p,ORM){const o=new zi("Hello");return new Sr(p,o)}', 'Boolean(f({},null).title)', true)],
    ['#169 exported host escapes', () => ore(imports +
        'export const config={};' + method + 'export function f(p){config.setup(new Sr(p,"Title"));}',
    'config.setup(' + strictRecipient + ');true', true)],
    ['#169 returned host escapes', () => ore(imports +
        'export function f(p){const config={};' + method + 'config.setup(new Sr(p,"Title")); return config;}',
    'f({}).setup(' + strictRecipient + ');true', true)],
    ['#169 returned computed member escapes', () => ore(imports +
        'function take(cfg){return cfg["setup"];}\nexport function f(p){const config={};' + method +
        'config.setup(new Sr(p,"Title"));return take(config);}',
    'f({})(' + strictRecipient + ');true', true)],
];

cases.push(['#168 non-target Modal constructor shadowed in loop', async () => {
    const source = [
        'import { ActionFormData, ModalFormData } from "@minecraft/server-ui";',
        'export function f(p) {',
        '  for (const ActionFormData = ModalFormData; ; ) {',
        '    const gui = new ActionFormData();',
        '    gui.title("ACHV§l Progress");',
        '    return gui.show(p);',
        '  }',
        '}',
    ].join('\n');
    const baseline = await convert(null, {}, source);
    const actual = await convert(route, {}, source);
    assert.deepEqual(actual.titles, baseline.titles);
    assert.equal(render(actual.titles[0], actual.en), prefix);
}]);

const oldEn = () => new Map([[other, prefix], [target, prefix], [ordinary, 'Progress']]);
const oldZh = (value = 'ACHV§l 成就进度') => new Map([[other, 'ACHV§l 另一个标题'], [target, value], [ordinary, '普通进度']]);
for (const [mode, input] of [
    ['fresh', {}],
    ['bilingual', { en_US: oldEn(), zh_CN: oldZh() }],
    ['zh-only', { zh_CN: oldZh() }],
]) {
    cases.push(['#168/#182 non-target key stability ' + mode, async () => {
        const baseline = await convert(null, input);
        const actual = await convert(route, input);
        reviewKeys(actual, baseline);
        assert.equal(translateKey(actual.titles[1]), translateKey(baseline.titles[1]));
        assert.notEqual(translateKey(actual.titles[0]), translateKey(actual.titles[1]));
    }]);
}
cases.push(
    ['#168/#182 old-key ownership', async () => {
        const actual = await convert(route, { en_US: oldEn(), zh_CN: oldZh() });
        assert.equal(translateKey(actual.titles[0]), target);
        assert.equal(render(actual.titles[0], actual.zh), 'ACHV§l 成就进度');
    }],
    ['#168/#182 old formatting and route marker', async () => {
        const value = '§aACHV§l 进度';
        const en = oldEn();
        en.delete(other);
        const zh = oldZh(value);
        zh.delete(other);
        const actual = await convert(route, { en_US: en, zh_CN: zh });
        const rendered = render(actual.titles[0], actual.zh);
        assert.equal(rendered.split('ACHV').length, 2, rendered);
        assert.ok(rendered === value || rendered === 'ACHV§l Progress', rendered);
        if (rendered !== value) assert.ok(actual.warnings.some(message => /ACHV/.test(message)), 'migration fallback needs an ACHV warning');
    }],
);

// R9's losing nested candidate must not prime a shallow lookup with a deep match.
cases.push(['CV-3A-2 R9 lookup order does not change the translation key', () => {
    const digits = '1234567890123456789012345678901234567890';
    const short = 'Mark ' + digits + ' Congratulations';
    const nested = 'Panel [Section (Notice: ' + short + ' / tag.)]';
    const patterns = [
        ['outer', ['Panel [', ']']], ['middle', ['Section (', ')']],
        ['first', ['Notice: ' + short + ' / ', '.']], ['later', ['Notice: ', ' / ', '.']],
        ['specific', ['Mark ' + digits + ' ', '']], ['generic', ['Mark ', ' Congratulations']],
    ];
    const expected = { rawtext: [{ translate: 'generic', with: { rawtext: [{ text: digits }] } }] };
    for (const [index, sequence] of [[nested, short, short], [short, nested, short]].entries()) {
        const key = '__review_cv3a2_' + index;
        const { content, rtName } = NS.processScript('export const f = x => "Temporary note: "+x;',
            'BP/scripts/review.js', new NS.ExtractContext({}), { injectRuntime: true, runtimeKey: key });
        const prelude = content.slice(0, content.indexOf('// ---- end i18n runtime ----'));
        try {
            const runtime = new Function(prelude + '\nreturn ' + rtName + ';')();
            runtime.reg([], patterns);
            for (const input of sequence) {
                const output = runtime.M(input);
                if (input === short) assert.deepEqual(output, expected);
            }
        } finally {
            delete globalThis[key];
        }
    }
}]);

const acceptance = [
    ['#168 ACHV visible title has an independent key', async () => {
        const actual = await convert(route);
        assert.deepEqual(actual.titles[0], { rawtext: [{ text: 'ACHV' }, { text: '§l ' }, { translate: target }] });
        assert.equal(actual.en.get(target), 'Progress');
    }],
    ...[false, true].map(withEnglish => ['#168 legacy translation migration ' + (withEnglish ? 'bilingual' : 'zh-only'), async () => {
        const input = { zh_CN: oldZh() };
        if (withEnglish) input.en_US = oldEn();
        const actual = await convert(route, input);
        assert.deepEqual(actual.titles[0], { rawtext: [{ text: 'ACHV' }, { text: '§l ' }, { translate: target }] });
        assert.equal(actual.zh.get(target), '成就进度');
    }]),
];

async function runReviewRegressions({ includeAcceptance = false } = {}) {
    assert.equal(classifications.length, cases.length, 'classification coverage');
    assert.equal(new Set(classifications.map(test => test.id)).size, cases.length, 'unique stable IDs');
    assert.deepEqual([...new Set(classifications.map(test => test.name))].sort(), cases.map(([name]) => name).sort(), 'classification names');
    for (const test of classifications) {
        assert.match(test.id, /^HR-\d{3}$/, 'stable historical ID');
        assert.ok(['Mandatory', 'Compatibility', 'Exploratory'].includes(test.tier), 'valid regression tier: ' + test.id);
    }
    const results = [];
    for (const [name, run] of includeAcceptance ? [...cases, ...acceptance] : cases) {
        const classification = classifications.find(test => test.name === name);
        const metadata = classification || { id: 'ACCEPTANCE', tier: 'Mandatory' };
        try { await run(); results.push({ ...metadata, name }); }
        catch (error) { results.push({ ...metadata, name, error }); }
    }
    return results;
}

if (require.main === module) {
    runReviewRegressions({ includeAcceptance: process.argv.includes('--acceptance') }).then(results => {
        for (const result of results) console.log(formatReviewResult(result));
        console.log(JSON.stringify(summarizeReviewResults(results)));
        process.exitCode = hasMandatoryFailure(results) ? 1 : 0;
    }).catch(error => { console.error(error); process.exitCode = 1; });
}

function hasMandatoryFailure(results) {
    return results.some(result => result.error && result.tier === 'Mandatory');
}

function formatReviewResult({ id, tier, name, error }) {
    return (error ? 'FAIL ' : 'PASS ') + '[' + tier + ' ' + id + '] ' + name + (error ? '\n' + error.message : '');
}

function summarizeReviewResults(results) {
    return Object.fromEntries(['Mandatory', 'Compatibility', 'Exploratory'].map(tier => {
        const group = results.filter(result => result.tier === tier);
        return [tier, { passed: group.filter(result => !result.error).length, failed: group.filter(result => result.error).length }];
    }));
}

module.exports = { runReviewRegressions, hasMandatoryFailure, formatReviewResult, summarizeReviewResults };
