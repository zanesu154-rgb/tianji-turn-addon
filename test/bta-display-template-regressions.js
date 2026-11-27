const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NS, MemFS } = require('./load');

const dictionary = `
const EN = {
    "job.transporter": "Transporter", "job.police": "Police officer",
    "job.salary": "Salary {0}$ per task", "job.current": "Current job: {0}",
    "hud.day": "Day {0}", "hud.bank": "Bank balance", "wallet.break": "Break one {0}",
};
const ES = {
    "fac.police": "Policía", "job.transporter": "Transportista", "job.police": "Policía",
    "job.salary": "Salario {0}$ por tarea", "job.current": "Trabajo actual: {0}",
    "hud.day": "Día {0}", "hud.bank": "Saldo bancario",
};
export const STRINGS = { en: EN, es: ES };
export function t(p, key, ...args) {
    let s = STRINGS[p.lang][key] ?? EN[key] ?? key;
    for (let i = 0; i < args.length; i++) s = s.split("{" + i + "}").join(String(args[i]));
    return s;
}
`;

const jobs = `
import { ActionFormData } from "@minecraft/server-ui";
import { t } from "./i18n.js";
const SALARY = { transporter: 55 };
export function jobsMenu(p) {
    const cur = p.job;
    const f = new ActionFormData().title(t(p, "job.transporter")).body(cur ? t(p, "job.current", t(p, "job." + cur)) : t(p, "job.none"));
    for (const id of Object.keys(SALARY)) f.button(\`\${t(p, "job." + id)}\\n§7\${t(p, "job.salary", SALARY[id])}\`);
    return f;
}
`;

const hud = `
import { t } from "./i18n.js";
const PANEL = "§r§r§r";
function panelText(p) {
    return PANEL + ["§f" + p.clock + "  §7" + t(p, "hud.day", p.day + 1), "§a$500", t(p, "hud.bank")].join("\\n");
}
export function renderPanel(p) {
    const title = panelText(p);
    p.onScreenDisplay.setTitle(title, { subtitle: " ", stayDuration: 40 });
}
`;

function runModule(content, context, returned) {
    const ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
    const body = ast.body.filter(n => n.type !== 'ImportDeclaration')
        .map(n => content.slice(n.declaration?.start ?? n.start, n.end)).join('\n');
    return vm.runInContext(`{ ${body}\n${returned}\n}`, context, { timeout: 1000 });
}

async function checkBtaDisplayTemplates() {
    const manifest = (type, uuid) => JSON.stringify({
        format_version: 2,
        header: { name: type, description: type, uuid, version: [1, 0, 0], min_engine_version: [1, 21, 0] },
        modules: [{ type, uuid: uuid.replace(/.$/, 'e'), version: [1, 0, 0] }],
        dependencies: type === 'data' ? [{ module_name: '@minecraft/server-ui', version: '2.0.0' }] : undefined,
    });
    const files = new Map([
        ['BP/manifest.json', manifest('data', '55555555-1111-4111-8111-111111111111')],
        ['RP/manifest.json', manifest('resources', '55555555-2222-4222-8222-222222222222')],
        ['BP/scripts/bta/i18n.js', dictionary], ['BP/scripts/bta/jobs.js', jobs], ['BP/scripts/bta/hud.js', hud],
    ]);
    const convert = async input => {
        const mem = new MemFS(input);
        await NS.runPipeline(mem, { sourceLang: 'en_US', targetLangs: ['zh_CN'] });
        return mem.files;
    };
    const fresh = await convert(files);
    const enPath = 'RP/texts/en_US.lang', zhPath = 'RP/texts/zh_CN.lang';
    const source = NS.parseLang(fresh.get(enPath));
    const key = value => {
        const match = [...source].find(([, text]) => text === value);
        assert.ok(match, value);
        return match[0];
    };
    key('Break one {0}');
    const salary = key('Salary %1$s$ per task'), current = key('Current job: %1$s'), day = key('Day %1$s');
    const role = key('Police officer'), transporter = key('Transporter');
    const backfilled = new Map(files);
    backfilled.set(enPath, fresh.get(enPath));
    backfilled.set(zhPath, [
        `${salary}=每单工资 {0}$## {0} comment`, `${current}=当前职业：{0}`,
        `${day}=第 {0} 天`, `${role}=警员`, 'sample.existing=原译文',
    ].join('\n') + '\n');
    const converted = await convert(backfilled);
    const translated = NS.parseLang(converted.get(zhPath));
    assert.deepEqual([salary, current, day, role, 'sample.existing'].map(k => translated.get(k)),
        ['每单工资 %1$s$', '当前职业：%1$s', '第 %1$s 天', '警员', '原译文']);
    assert.match(converted.get(zhPath), /%1\$s\$## \{0\} comment/);
    assert.deepEqual([...translated.keys()].slice(0, 5), [salary, current, day, role, 'sample.existing']);
    const rerun = await convert(converted);
    assert.equal(rerun.get(zhPath), converted.get(zhPath));
    assert.equal(rerun.get('BP/scripts/bta/i18n.js'), converted.get('BP/scripts/bta/i18n.js'));
    const unrelated = NS.processScript(dictionary, 'BP/scripts/other/i18n.js', new NS.ExtractContext());
    assert.doesNotMatch(unrelated.content, /__i18n\.regNumbered\(/);
    const sandbox = vm.createContext({
        ActionFormData: class {
            title(value) { this.heading = value; return this; }
            body(value) { this.bodyText = value; return this; }
            button(value) { this.buttonText = value; return this; }
        },
    });
    const from = (file, expr) => runModule(converted.get('BP/scripts/bta/' + file), sandbox, expr);
    from('i18n.js', 'globalThis.t = t; globalThis.mapDisplay = __i18n.M;');
    const jobsMenu = from('jobs.js', 'jobsMenu;');
    const renderPanel = from('hud.js', 'renderPanel;');
    const player = { lang: 'en', job: 'police', clock: '07:00', day: 0 };
    const form = jobsMenu(player);
    const plain = value => JSON.parse(JSON.stringify(value));
    const withArg = (translate, arg) => ({ translate, with: { rawtext: [arg] } });
    const flatten = message => message.rawtext ? message.rawtext.flatMap(flatten) : [message];
    assert.deepEqual(flatten(plain(form.buttonText)), [
        { translate: transporter }, { text: '\n§7' }, withArg(salary, { text: '55' }),
    ]);
    assert.deepEqual(plain(form.bodyText), { rawtext: [withArg(current, { translate: role })] });
    let panel;
    player.onScreenDisplay = { setTitle(text, options) { panel = plain({ text, options }); } };
    renderPanel(player);
    assert.ok(panel.text.rawtext.some(e => e.text === '§r§r§r§f07:00  §7'));
    assert.ok(panel.text.rawtext.some(e => JSON.stringify(e) === JSON.stringify(withArg(day, { text: '1' }))));
    assert.deepEqual(panel.options, { subtitle: ' ', stayDuration: 40 });
    const spanish = jobsMenu({ ...player, lang: 'es' });
    assert.ok(flatten(plain(spanish.buttonText)).some(e => e.translate === key('Salario %1$s$ por tarea')));
    assert.deepEqual(plain(spanish.bodyText), { rawtext: [withArg(key('Trabajo actual: %1$s'), { text: 'Policía' })] });
    assert.equal(sandbox.t(player, 'job.salary', 55), 'Salary 55$ per task');
    for (const line of ['Current job: custom role', 'Salary variable$ per task', 'Wanted level 1']) {
        assert.equal(sandbox.mapDisplay(line), line);
    }
}

module.exports = { checkBtaDisplayTemplates };
