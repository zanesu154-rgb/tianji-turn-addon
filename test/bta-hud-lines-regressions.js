const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NS } = require('./load');

function checkBtaHudLines() {
    const source = `
const PANEL = "§r§r§r";
function panelText(p) { return PANEL + p.rows.join("\\n"); }
function renderPanel(p) {
    try {
        const title = p.hud ? panelText(p) : PANEL;
        p.onScreenDisplay.setTitle(title, { subtitle: p.map, stayDuration: 40 });
    } catch { }
}
function renderNotice(p, text) { p.onScreenDisplay.setTitle(text); }
`;
    const { content } = NS.processScript(source, 'BP/scripts/bta/hud.js', new NS.ExtractContext());
    acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
    const { renderPanel, renderNotice, runtime } = vm.runInNewContext(content +
        '\n({ renderPanel, renderNotice, runtime: __i18n })', {}, { timeout: 1000 });
    const rows = ['§f07:00  §7Day 1', '§8☆', '§a$600', '§7Bank §b$0', '§c§lBTA §r§6EL SANDO'];
    runtime.reg([
        [rows.slice(1).join(' '), 'hud.wrongly.joined'],
        ['Bank', 'hud.bank'], ['BTA EL SANDO', 'hud.label'], ['Debt', 'hud.debt'],
        ['A description originally wrapped by the addon', 'notice.folded'],
    ], []);
    runtime.regNumbered([['hud.day', 'Day ', '', null, true]]);
    let call;
    const p = {
        hud: true, rows, map: '§a•', onScreenDisplay: { setTitle(text, options) { call = { text, options }; } },
    };
    const actual = () => JSON.parse(JSON.stringify(call));
    renderPanel(p);
    assert.equal(actual().text.rawtext.filter(item => item.text === '\n').length, 4);
    assert.deepEqual(actual().text.rawtext.slice(0, 2), [
        { text: '§r§r§r§f07:00  §7' },
        { translate: 'hud.day', with: { rawtext: [{ text: '1' }] } },
    ]);
    assert.ok(actual().text.rawtext.some(item => item.translate === 'hud.bank'));
    assert.ok(actual().text.rawtext.every(item => item.translate !== 'hud.wrongly.joined'));
    assert.deepEqual(actual().options, { subtitle: '§a•', stayDuration: 40 });

    p.rows = [...rows.slice(0, 4), '§cDebt -$25', rows[4]];
    renderPanel(p);
    assert.equal(actual().text.rawtext.filter(item => item.text === '\n').length, 5);
    assert.ok(actual().text.rawtext.some(item => item.text === '§cDebt -$25'));
    p.hud = false;
    renderPanel(p);
    assert.equal(actual().text, '§r§r§r');

    renderNotice(p, 'A description originally\nwrapped by the addon');
    assert.deepEqual(actual().text, { rawtext: [{ translate: 'notice.folded' }] });
}

module.exports = { checkBtaHudLines };
