// Manual acceptance: node test/bta-display-template-real.js ORIGINAL.mcworld HISTORICAL-TRANSLATION.zip
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { NS, MemFS } = require('./load');
const Zip = require('../vendor/jszip.min.js');

const scripts = 'behavior_packs/B/scripts/bta/';
const rpTexts = 'resource_packs/R/texts/';
const languages = ['en_US', 'zh_CN'];
const parse = source => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

async function readArchive(bytes) {
    const zip = await Zip.loadAsync(bytes);
    return new Map(await Promise.all(Object.values(zip.files).filter(entry => !entry.dir)
        .map(async entry => [entry.name, await entry.async('nodebuffer')])));
}

function inspectTemplates(files) {
    const source = String(files.get(scripts + 'i18n.js'));
    const call = parse(source).body.find(node => node.expression?.callee?.property?.name === 'regNumbered');
    assert.ok(call, 'generated BTA registration');
    const arg = call.expression.arguments[0];
    const rules = JSON.parse(source.slice(arg.start, arg.end));
    assert.equal(rules.length, 6);
    assert.equal(new Set(rules.map(([key]) => key)).size, 6);
    const lang = NS.parseLang(String(files.get(rpTexts + 'zh_CN.lang')));
    return rules.map(([key, head, tail]) => {
        const text = lang.get(key);
        assert.match(text, /%1\$s/);
        return { template: head + '{0}' + tail, key, text };
    });
}

function loadDeclarations(context, source, names, expose) {
    const start = source.indexOf('// ---- i18n runtime (auto-generated) ----');
    const end = source.indexOf('// ---- end i18n runtime ----');
    assert.ok(start >= 0 && end > start);
    const declarations = parse(source).body.flatMap(node => {
        const decl = node.declaration ?? node;
        return names.includes(decl.id?.name) || decl.declarations?.some(item => names.includes(item.id.name))
            ? [source.slice(decl.start, decl.end)] : [];
    });
    vm.runInContext(`{ ${source.slice(start, end)}\n${declarations.join('\n')}\n${expose} }`, context, { timeout: 2000 });
}

async function checkSpanishPolice(files, templates, translated) {
    let body;
    class ActionFormData {
        title() { return this; }
        body(value) { body = value; return this; }
        button() { return this; }
    }
    const player = { getDynamicProperty(name) { return name === 'sando:lang' ? 'es' : undefined; } };
    const context = vm.createContext({
        ActionFormData, player, pget: (_, key) => key === 'job' ? 'police' : '',
        showForm: async () => ({ canceled: true }),
    });
    loadDeclarations(context, String(files.get(scripts + 'i18n.js')), ['EN','ES','STRINGS','getLang','t'], 'globalThis.t = t;');
    loadDeclarations(context, String(files.get(scripts + 'jobs.js')), ['JOBS','SALARY','job','jobsMenu'], 'globalThis.jobsMenu = jobsMenu;');
    const name = vm.runInContext('t(player, "job.police")', context, { timeout: 2000 });
    assert.equal(name, 'Policía');
    await vm.runInContext('jobsMenu(player)', context, { timeout: 2000 });
    const entry = templates.find(item => item.template === 'Trabajo actual: {0}');
    const message = JSON.parse(JSON.stringify(body));
    assert.deepEqual(message, { rawtext: [{ translate: entry.key, with: { rawtext: [{ text: name }] } }] });
    const rendered = entry.text.replace('%1$s', name);
    assert.doesNotMatch(rendered, /警察局/);
    if (translated) assert.equal(rendered, '当前工作：Policía');
    return { templateKey: entry.key, argument: message.rawtext[0].with.rawtext[0], rendered };
}

async function checkBtaRealSample(originalPath, translatedPath) {
    const bytes = fs.readFileSync(originalPath);
    const original = await readArchive(bytes);
    const historical = await readArchive(fs.readFileSync(translatedPath));
    for (const dir of ['behavior_packs/B', 'resource_packs/R']) {
        const manifest = JSON.parse(String(original.get(dir + '/manifest.json')));
        assert.deepEqual(manifest.header.version, [2, 7, 0]);
    }
    const convert = async (exported, selected = []) => {
        const mem = new MemFS(original);
        for (const dir of ['behavior_packs/B/texts/', rpTexts]) for (const lang of selected) {
            const path = dir + lang + '.lang';
            if (exported.has(path)) mem.writeBytes(path, exported.get(path));
        }
        await NS.runWorldPipeline(mem, { targetLangs: languages });
        const modules = [...mem.files].filter(([path]) => /\.m?js$/i.test(path));
        assert.equal(modules.length, 100);
        for (const [path, bytes] of modules) assert.doesNotThrow(() => parse(String(bytes)), path);
        return mem.files;
    };

    const fresh = await convert();
    const translated = await convert(historical, languages);
    for (const [source, first, hasTranslation] of [['fresh', fresh, false], ['historical', translated, true]]) {
        const firstTemplates = inspectTemplates(first);
        console.log(JSON.stringify({ source, mode: 'first', modules: 100, templates: firstTemplates,
            spanish: await checkSpanishPolice(first, firstTemplates, hasTranslation) }));
        for (const [mode, selected] of [['bilingual', languages], ['zh-only', ['zh_CN']]]) {
            // The original scripts remain in place. Copy exported .lang bytes as-is.
            const second = await convert(first, selected);
            const secondTemplates = inspectTemplates(second);
            assert.deepEqual(secondTemplates, firstTemplates, source + ' / ' + mode);
            console.log(JSON.stringify({ source, mode, modules: 100, templates: secondTemplates,
                spanish: await checkSpanishPolice(second, secondTemplates, hasTranslation) }));
        }
    }
    assert.equal(checksum(fs.readFileSync(originalPath)), checksum(bytes));
    console.log('PASS BTA6 2.7.0 ' + checksum(bytes));
}

if (require.main === module) {
    const [original, translated] = process.argv.slice(2);
    if (!original || !translated) {
        console.error('Usage: node test/bta-display-template-real.js ORIGINAL.mcworld HISTORICAL-TRANSLATION.zip');
        process.exitCode = 2;
    } else {
        checkBtaRealSample(original, translated).catch(error => { console.error(error); process.exitCode = 1; });
    }
}
