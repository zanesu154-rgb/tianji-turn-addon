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

function render(message, lang) {
    if (typeof message === 'string') return message;
    if (message.rawtext) return message.rawtext.map(part => render(part, lang)).join('');
    if (typeof message.text === 'string') return message.text;
    assert.ok(lang.has(message.translate), message.translate);
    const args = message.with?.rawtext || [];
    return lang.get(message.translate).replace(/%(\d+)\$s/g, (_, slot) => render(args[Number(slot) - 1], lang));
}

async function checkTaxi(files, templates, translated) {
    let body;
    let buttons;
    class ActionFormData {
        title() { return this; }
        body(value) { body = value; return this; }
        button(value) { buttons.push(value); return this; }
    }
    const player = { authorLanguage: 'en', job: 'taxi', getDynamicProperty(name) {
        return name === 'sando:lang' ? this.authorLanguage : undefined;
    } };
    const context = vm.createContext({
        ActionFormData, player, pget: (p, key) => key === 'job' ? p.job : '',
        showForm: async () => ({ canceled: true }),
    });
    const from = (file, names, expose) => loadDeclarations(context, String(files.get(scripts + file)), names, expose);
    from('city2.js', [], 'globalThis.mapCity = __i18n.M;');
    from('i18n.js', ['EN','ES','STRINGS','getLang','t'], 'Object.assign(globalThis, { EN, ES, t, runtime: __i18n });');
    from('jobs.js', ['JOBS','SALARY','job','jobsMenu'], 'Object.assign(globalThis, { JOBS, jobsMenu });');
    const plain = message => JSON.parse(JSON.stringify(message));
    const lang = NS.parseLang(String(files.get(rpTexts + 'zh_CN.lang')));
    const city = plain(context.mapCity('Policía'));
    assert.deepEqual(city, { rawtext: [{ translate: 'script.city2.str_2' }] });
    if (translated) assert.equal(render(city, lang), '警察局');
    const raw = { rawtext: [{ text: 'leave unchanged' }] };
    assert.equal(context.runtime.currentJob(raw, 'taxi'), raw);

    const results = {};
    for (const [locale, dictionary, jobText, bodyPattern, salaryPattern, key] of [
        ['en', context.EN, 'Taxi driver', 'Current job: {0}', 'Salary {0}$ per task', 'script.i18n.str_573'],
        ['es', context.ES, 'Taxista', 'Trabajo actual: {0}', 'Salario {0}$ por tarea', 'script.i18n.str_1495'],
    ]) {
        assert.equal(dictionary['job.taxi'], jobText);
        assert.equal(dictionary['role.taxi_driver'], jobText);
        player.authorLanguage = locale;
        assert.equal(context.t(player, 'job.taxi'), jobText);
        assert.equal(context.t(player, 'role.taxi_driver'), jobText);
        buttons = [];
        await context.jobsMenu(player);
        const entry = templates.find(item => item.template === bodyPattern);
        const salary = templates.find(item => item.template === salaryPattern);
        const message = plain(body);
        const button = plain(buttons[2 + Object.keys(context.JOBS).indexOf('taxi')]);
        assert.deepEqual(message, { rawtext: [{ translate: entry.key, with: { rawtext: [{ translate: key }] } }] });
        const parts = button.rawtext.flatMap(part => part.rawtext || [part]);
        assert.equal(parts[0].translate, key);
        assert.ok(parts.some(part => part.translate === salary.key));
        const taxiLabel = translated ? '出租车司机' : jobText;
        assert.equal(lang.get(key), taxiLabel);
        assert.equal(render(message, lang), entry.text.replace('%1$s', taxiLabel));
        if (translated) assert.equal(render(message, lang), '当前工作：出租车司机');
        const salaryText = salary.text.replace('%1$s', '40');
        assert.equal(render(button, lang), taxiLabel + '\n§7' + salaryText);
        results[locale] = { key, body: render(message, lang), button: render(button, lang) };
    }

    player.job = 'unknown_job';
    buttons = [];
    await context.jobsMenu(player);
    assert.equal(body, context.t(player, 'job.current', context.t(player, 'job.' + player.job)));
    return results;
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
        const report = async (files, mode, templates) => console.log(JSON.stringify({ source, mode, modules: 100, templates,
            spanish: await checkSpanishPolice(files, templates, hasTranslation),
            taxi: await checkTaxi(files, templates, hasTranslation) }));
        await report(first, 'first', firstTemplates);
        for (const [mode, selected] of [['bilingual', languages], ['zh-only', ['zh_CN']]]) {
            // The original scripts remain in place. Copy exported .lang bytes as-is.
            let exported = first;
            for (let round = 1; round <= (hasTranslation ? 2 : 1); round++) {
                exported = await convert(exported, selected);
                const templates = inspectTemplates(exported);
                assert.deepEqual(templates, firstTemplates, source + ' / ' + mode + ' / ' + round);
                await report(exported, mode + '-' + round, templates);
            }
        }
    }
    // Seed a separate closed loop directly from the original historical zh_CN bytes.
    let zhOnly = historical;
    for (let round = 0; round <= 2; round++) {
        zhOnly = await convert(zhOnly, ['zh_CN']);
        const zhTemplates = inspectTemplates(zhOnly);
        assert.deepEqual(zhTemplates, inspectTemplates(translated));
        console.log(JSON.stringify({ source: 'original historical zh_CN', mode: 'zh-only-' + round, modules: 100, templates: zhTemplates,
            spanish: await checkSpanishPolice(zhOnly, zhTemplates, true), taxi: await checkTaxi(zhOnly, zhTemplates, true) }));
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
