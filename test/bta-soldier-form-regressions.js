const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NS } = require('./load');

function checkBtaSoldierForm() {
    const lang = `
export const STR = {
    en: { "sando.ui.neutral.body": "Member of %1. Wear %1.", "sando.ui.btn.close": "Close", "sando.team.terrorist": "Terrorists" },
    es: { "sando.ui.neutral.body": "Miembro de %1. Usa %1.", "sando.ui.btn.close": "Cerrar", "sando.team.terrorist": "Terroristas" },
};
`;
    const war = `
import { STR } from "./lang.js";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";
function getLang(p) { return p.lang; }
function tr(key, ...a) { return { __t: key, a }; }
function R(p, m) { return m.__t ? (STR[p.lang]?.[m.__t] ?? STR.en[m.__t] ?? m.__t) : "author resolver"; }
function LF(p, form) {
    const proxy = new Proxy(form, {
        get(target, prop) {
            const v = target[prop];
            if (typeof v !== "function") return v;
            if (prop === "show") return (...a) => v.apply(target, a);
            return (...args) => {
                const r = v.apply(target, args.map((a) => (a && typeof a === "object" && (a.__t || a.rawtext || a.translate)) ? R(p, a) : a));
                return r === target ? proxy : r;
            };
        },
    });
    return proxy;
}
function openSoldierMenu(player, title) {
    return LF(player, new ActionFormData()).title(title)
        .body(tr("sando.ui.neutral.body", tr("sando.team.terrorist"))).button(tr("sando.ui.btn.close"), "textures/ui/icon").show(player);
}
function openMessage(player) { return LF(player, new MessageFormData()).title(tr("sando.ui.btn.close")).show(player); }
function openOtherAction(player) { return LF(player, new ActionFormData()).title(tr("sando.ui.btn.close")).show(player); }
`;
    const context = new NS.ExtractContext();
    const compile = (name, source) => NS.processScript(source, 'BP/scripts/bod/sando/' + name, context).content;
    const run = (code, box, end) => {
        const tree = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
        const body = tree.body.filter(n => n.type !== 'ImportDeclaration').map(n => code.slice(n.declaration?.start ?? n.start, n.end)).join('\n');
        return vm.runInContext('{'+ body + '\n' + end + '}', box, { timeout: 1000 });
    };
    class ActionFormData {
        title(value) { this.heading = value; return this; }
        body(value) { this.description = value; return this; }
        button(value, icon) { this.close = [value, icon]; return this; }
        show(player) { return { heading: this.heading, description: this.description, close: this.close, player }; }
    }
    class MessageFormData extends ActionFormData {}
    const box = vm.createContext({ ActionFormData, MessageFormData });
    run(compile('lang.js', lang), box, 'globalThis.STR = STR;');
    const then = run(compile('warfare.js', war), box, '({ openSoldierMenu, openMessage, openOtherAction, R, adapt: __i18n.soldierText, routes: __i18n.regFormLocales });');
    const lookup = text => [...context.entries].find(([, entry]) => entry.value === text)?.[0];
    const player = { lang: 'missing', clientSystemInfo: { locale: 'zh-CN' } };
    const nativeTitle = { rawtext: [{ text: '§4[TRR]§r ' }, { translate: 'item.example.name', with: ['test'] }] };
    const plain = value => JSON.parse(JSON.stringify(value));
    const close = lookup('Close'), team = lookup('Terrorists'), body = lookup('Member of %1. Wear %1.');
    then.routes([close, team, body].map(key => [key, ['zh_cn'], { en: key + '.lfmc_form_en', es: key + '.lfmc_form_es' }]));
    const form = then.openSoldierMenu(player, nativeTitle);
    assert.equal(form.heading, nativeTitle);
    assert.deepEqual(plain(form.description), { translate: body, with: { rawtext: [{ translate: team }] } });
    assert.deepEqual(plain(form.close), [{ translate: close }, 'textures/ui/icon']);
    assert.equal(form.player, player);
    assert.equal(then.openMessage(player).heading, 'Close');
    assert.equal(then.openOtherAction(player).heading, 'Close');
    const alias = { translate: 'sando.ui.neutral.body', with: { rawtext: [{ translate: 'sando.team.terrorist' }] } };
    assert.deepEqual(plain(then.adapt(alias, 'es', box.STR, player)), plain(form.description));
    assert.deepEqual(plain(then.adapt({ ...alias, with: [{ __t: 'sando.team.terrorist' }] }, 'es', box.STR, player)), plain(form.description));

    const fallbackPlayer = { lang: 'es', clientSystemInfo: { locale: 'en_US' } };
    const fallbackForm = then.openSoldierMenu(fallbackPlayer, nativeTitle);
    assert.deepEqual(plain(fallbackForm.close), [{ text: 'Cerrar' }, 'textures/ui/icon']);
    assert.deepEqual(plain(fallbackForm.description), { rawtext: [
        { text: 'Miembro de ' }, { text: 'Terroristas' }, { text: '. Usa ' }, { text: 'Terroristas' }, { text: '.' },
    ] });
    const legacy = then.openSoldierMenu({ lang: 'es' }, nativeTitle);
    assert.deepEqual(plain(legacy.close), [{ translate: close + '.lfmc_form_es' }, 'textures/ui/icon']);
    assert.equal(then.R(player, { __t: 'sando.ui.btn.close' }), 'Close');
    const unknown = { translate: 'vanilla.example', with: ['original'] };
    assert.equal(then.adapt(unknown, 'en', box.STR), unknown);
    const fallback = then.adapt({ __t: 'author.alias', a: [unknown] }, 'missing', { en: { 'author.alias': 'Alias %1/%1' } });
    assert.deepEqual(plain(fallback), { rawtext: [{ text: 'Alias ' }, unknown, { text: '/' }, unknown, { text: '' }] });
}

module.exports = { checkBtaSoldierForm };
