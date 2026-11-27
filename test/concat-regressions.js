const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NS } = require('./load');

function checkTeamButtonConcat() {
    const source = [
        'import { ActionFormData } from "@minecraft/server-ui";',
        'function teamName(team) { return team === "home" ? "Home Team" : "Away Team"; }',
        'function build(team, count, describe) {',
        '  const form = new ActionFormData();',
        '  form.button((team === "home" ? "§1" : "§4") + teamName(team) + "\\n§8" + describe(count, { side: team }));',
        '  return form;',
        '}',
    ].join('\n');
    const ctx = new NS.ExtractContext({ splitNewlines: false });
    const { content } = NS.processScript(source, 'BP/scripts/ball/items.js', ctx, { injectRuntime: true });
    const ast = globalThis.acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
    const declaration = ast.body.find(node => node.type === 'ImportDeclaration');
    const runnable = content.slice(0, declaration.start) + content.slice(declaration.end);
    class ActionFormData {
        button(message) { this.message = message; }
    }
    const build = vm.runInNewContext(runnable + '\nbuild', { ActionFormData }, { timeout: 1000 });
    const entries = new Map([...ctx.entries].map(([key, item]) => [key, item.value]));
    const names = new Map([['Home Team', '主队'], ['Away Team', '客队']]);
    const render = part => {
        if (part.rawtext) return part.rawtext.map(render).join('');
        if (!part.translate) return part.text;
        const sourceText = entries.get(part.translate);
        assert.ok(names.has(sourceText), `unexpected translation key ${part.translate}`);
        return names.get(sourceText);
    };
    for (const [team, color, label] of [['home', '§1', '主队'], ['away', '§4', '客队']]) {
        const args = [];
        const form = build(team, 3, (count, options) => {
            args.push([count, options.side]);
            return 'Count: ' + count;
        });
        assert.deepEqual(args, [[3, team]]);
        assert.equal(render(form.message), `${color}${label}\n§8Count: 3`);
    }
}

module.exports = { checkTeamButtonConcat };
