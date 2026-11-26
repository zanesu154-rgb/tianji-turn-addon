const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { NS, MemFS, readDir } = require('./load');

const oreSource = `import {
    CustomForm as Form, ObservableString as Text, /* keep this import */
    ObservableUIRawMessage as ExistingRaw,
} from "@minecraft/server-ui";
const slots = [0, 1];
function color(form, value) {
    const line = new Text("");
    form.label(line);
    const refresh = next => line.setData(next);
    refresh(value);
    return refresh;
}
function displayColor(form, value) { return color(form, value); }
function addRows(form, options) { options.rowsEnd && options.rowsEnd(form); }
export function settings(player, initial, ExistingRaw) {
    const title = new Text(initial, { clientWritable: false });
    let form;
    try { form = new Form(player, title); }
    catch (error) { throw error; }
    const summaries = {}, actions = {};
    for (const slot of slots) {
        summaries[slot] = new Text("");
        actions[slot] = new Text("");
        form.label(summaries[slot]);
        form.button(actions[slot]);
    }
    const refreshColor = displayColor(form, "§8No color");
    let refreshOff;
    const options = {};
    options.rowsEnd = receiver => { refreshOff = color(receiver, "§8Off"); };
    addRows(form, options);
    const refresh = state => {
        for (const slot of slots) {
            const value = state[slot];
            const disabled = value === "Off" || value === "toggle";
            summaries[slot].setData(disabled ? "§8-" : "§7" + value);
            actions[slot].setData(disabled ? "Set action" : "Change action");
        }
        title.setData((state.touch(), state.title));
    };
    return { form, refresh, refreshColor, refreshOff };
}
export function nonDisplay(player, opts, OtherForm) {
    const form = new Form(player, new Text("Light - Settings"));
    const writable = new Text("", { ...opts });
    const mode = new Text("toggle");
    const shared = new Text("White");
    form.textField("Blueprint", writable);
    if (mode.getData() === "toggle") form.label(mode);
    form.label(shared);
    let reassigned;
    reassigned = new Form(player, "Label");
    reassigned = new OtherForm(player, "Other");
    const unknown = new Text("White");
    reassigned.label(unknown);
    for (let Form = OtherForm, i = 0; i < 1; i++) {
        const label = new Text("White");
        new Form(player, "Other").label(label);
    }
    const escapingOptions = {};
    escapingOptions.rowsEnd = receiver => {
        const label = new Text("White");
        receiver.label(label);
    };
    addRows(form, escapingOptions);
    return { form, writable, mode, shared, escapingOptions };
}
export const catalog = ["Light - Settings", "Set action", "Change action", "White", "§8Off", "§8No color"];
`;

const opt = { baseName: 'fixture', sourceLang: 'en_US', targetLangs: ['en_US', 'zh_CN'] };
const script = 'BP/scripts/ore_ui_settings.js';

async function convert(source, putBack = new Map(), injectRuntime = true) {
    const files = readDir(path.join(__dirname, 'fixture'));
    for (const [name, content] of putBack) files.set(name, content);
    files.set(script, source);
    const mem = new MemFS(files);
    await NS.runPipeline(mem, { ...opt, injectRuntime });
    return mem;
}

const texts = mem => new Map([...mem.files].filter(([name]) => /\/texts\//.test(name)));
const read = (mem, name) => String(mem.files.get(name));
const readOre = mem => read(mem, script);

function runModule(output, priorRuntime) {
    const ast = globalThis.acorn.parse(output, { ecmaVersion: 'latest', sourceType: 'module' });
    const imports = ast.body.filter(node => node.type === 'ImportDeclaration');
    const isRaw = value => value && (typeof value.text === 'string' || typeof value.translate === 'string' ||
        (Array.isArray(value.rawtext) && value.rawtext.every(isRaw)));
    class ObservableString {
        constructor(value, options) { this.options = options; this.setData(value); }
        setData(value) { assert.equal(typeof value, 'string'); this.value = value; }
        getData() { return this.value; }
    }
    class ObservableUIRawMessage {
        constructor(value, options) { this.options = options; this.setData(value); }
        setData(value) { assert.ok(isRaw(value), 'expected UIRawMessage'); this.value = value; }
    }
    class CustomForm {
        constructor(player, title) { this.title = title; this.labels = []; this.buttons = []; }
        label(value) { this.labels.push(value); }
        button(value) { this.buttons.push(value); }
        textField(name, value) { assert.ok(value instanceof ObservableString); }
    }
    const types = { CustomForm, ObservableString, ObservableUIRawMessage };
    const args = Object.fromEntries(imports.flatMap(node => node.specifiers.map(spec => [spec.local.name, types[spec.imported.name]])));
    if (priorRuntime) args[JSON.parse(/const g = globalThis, K = ("[^"]+");/.exec(output)[1])] = priorRuntime;
    let body = output;
    for (const node of imports.reverse()) body = body.slice(0, node.start) + body.slice(node.end);
    body = body.replace(/^export /gm, '');
    return vm.runInNewContext(body + '\n({ settings, nonDisplay });', args, { timeout: 1000 });
}

function display(value, lang) {
    if (value.rawtext) return value.rawtext.map(item => display(item, lang)).join('');
    if (value.translate) return lang.get(value.translate) ?? `<missing ${value.translate}>`;
    return value.text;
}

async function runOreUiRegressions() {
    const controlSource = oreSource.replace('@minecraft/server-ui', './local-form.js');
    const control = await convert(controlSource);
    const converted = await convert(oreSource);
    const output = readOre(converted);
    const enPath = 'RP/texts/en_US.lang', zhPath = 'RP/texts/zh_CN.lang';
    const en = NS.parseLang(read(converted, enPath));
    const translations = new Map([
        ['Light - Settings', '灯光设置'], ['Set action', '设置动作'], ['Change action', '更改动作'],
        ['White', '白色'], ['§8Off', '§8关闭'], ['§8No color', '§8无颜色'],
    ]);
    const zh = new Map([...en].map(([key, text]) => [key, translations.get(text) ?? text]));
    const zhFile = read(converted, zhPath).split('\n').map(line => {
        const eq = line.indexOf('=');
        const translated = eq > 0 && translations.get(line.slice(eq + 1));
        return translated ? line.slice(0, eq + 1) + translated : line;
    }).join('\n');
    const result = [];
    const check = async (name, test) => {
        try { await test(); result.push({ name }); }
        catch (error) { result.push({ name, error }); }
    };
    await check('#169 Ore UI 首次显示与刷新使用现有译文，保留颜色及逻辑值', () => {
        assert.ok(output.includes(oreSource.slice(0, oreSource.indexOf('const slots'))));
        const { settings, nonDisplay } = runModule(output);
        const { form, refresh, refreshColor, refreshOff } = settings({}, 'Light - Settings', null);
        const render = item => display(item.value, zh);
        assert.equal(render(form.title), '灯光设置');
        assert.equal(form.title.options.clientWritable, false);
        assert.equal(render(form.labels[2]), '§8无颜色');
        assert.equal(render(form.labels[3]), '§8关闭');
        let touched = 0;
        refresh({ 0: 'White', 1: 'Off', title: 'Light - Settings', touch: () => touched++ });
        assert.equal(render(form.labels[0]), '§7白色');
        assert.equal(render(form.labels[1]), '§8-');
        assert.equal(render(form.buttons[0]), '更改动作');
        assert.equal(render(form.buttons[1]), '设置动作');
        refresh({ 0: 'toggle', 1: 'White', title: 'unregistered value', touch: () => touched++ });
        assert.equal(render(form.title), 'unregistered value');
        assert.equal(render(form.buttons[0]), '设置动作');
        assert.equal(render(form.buttons[1]), '更改动作');
        assert.equal(touched, 2);
        refreshColor('White');
        refreshOff('§8No color');
        assert.equal(render(form.labels[2]), '白色');
        assert.equal(render(form.labels[3]), '§8无颜色');

        class OtherForm { label(observable) { assert.equal(observable.getData(), 'White'); } }
        const { writable, mode, shared, escapingOptions } = nonDisplay({}, { clientWritable: true }, OtherForm);
        assert.equal(writable.options.clientWritable, true);
        assert.equal(mode.getData(), 'toggle');
        assert.equal(shared.getData(), 'White');
        escapingOptions.rowsEnd(new OtherForm());
    });
    await check('#169 fresh、双语与仅中文回填保留 lang 字节、键顺序和用户译文', async () => {
        assert.deepEqual(texts(converted), texts(control));
        for (const putBack of [
            new Map([[enPath, read(control, enPath)], [zhPath, zhFile]]),
            new Map([[zhPath, zhFile]]),
        ]) {
            const current = await convert(oreSource, putBack);
            const reference = await convert(controlSource, putBack);
            assert.deepEqual(texts(current), texts(reference));
            const existing = NS.parseLang(read(current, zhPath));
            for (const [key, english] of en) {
                if (translations.has(english)) assert.equal(existing.get(key), translations.get(english), key);
            }
        }
    });
    await check('#169 关闭运行时保持原类型，适配器兼容先加载的共享运行时', async () => {
        assert.doesNotMatch(readOre(await convert(oreSource, new Map(), false)), /ObservableUIRawMessage as __i18n/);
        const priorRuntime = { reg() {}, M: value => value === 'Light - Settings' ? { text: 'old runtime' } : value };
        const { settings } = runModule(output, priorRuntime);
        const { form } = settings({}, 'Light - Settings');
        assert.equal(form.title.value.text, 'old runtime');
        assert.equal(form.labels[2].value.text, '§8No color');
    });
    return result;
}

module.exports = { runOreUiRegressions };
