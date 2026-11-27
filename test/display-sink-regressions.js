const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NS } = require('./load');

function checkForwardedDisplaySinks() {
    const source = [
        'import { world } from "@minecraft/server";',
        'const PREFIX = "§6[§cBTA§6]§r ";',
        'const known = ["Daily reward ready", "Welcome to town", "Your phone is in your inventory"];',
        'function send(player, message) { player.sendMessage(PREFIX + message); }',
        'function forward(player, message) { player.sendMessage(message); }',
        'function title(player, a, b = "", time = 60) {',
        '  return (globalThis.titleHook ?? ((p, text, opts) => p.onScreenDisplay.setTitle(text, opts)))(',
        '      player, a, { subtitle: b, fadeInDuration: 5, stayDuration: time, fadeOutDuration: 12 });',
        '}',
    ].join('\n');
    const context = new NS.ExtractContext();
    const { content } = NS.processScript(source, 'BP/scripts/core.js', context, {
        collidingMethods: new Set(['sendMessage']),
    });
    const ast = globalThis.acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
    const environment = {};
    class Player {
        constructor() {
            this.onScreenDisplay = { setTitle(text, options) { return { text, options }; } };
        }
        sendMessage(message) { this.lastChat = message; }
    }
    let body = content;
    for (const node of ast.body.filter(n => n.type === 'ImportDeclaration').reverse()) {
        for (const spec of node.specifiers) if (spec.imported?.name === 'Player') environment[spec.local.name] = Player;
        body = body.slice(0, node.start) + body.slice(node.end);
    }
    const { send, forward, title, known, setHook } = vm.runInNewContext(body + '\n' +
        '({ send, forward, title, known, setHook(hook) { globalThis.titleHook = hook; } })', environment, { timeout: 1000 });
    const keyFor = text => [...context.entries].find(([, entry]) => entry.value === text)?.[0];
    const prefix = '§6[§cBTA§6]§r ';
    const player = new Player();
    send(player, known[0]);
    assert.equal(player.lastChat.rawtext[0].text, prefix);
    assert.equal(player.lastChat.rawtext[1].rawtext[0].translate, keyFor(known[0]));

    const fake = { sendMessage(message) { this.lastChat = message; } };
    send(fake, known[0]);
    assert.equal(fake.lastChat, prefix + known[0]);
    send(player, 'unregistered notice');
    assert.equal(player.lastChat, prefix + 'unregistered notice');
    const raw = { rawtext: [{ text: known[0] }] };
    forward(player, raw);
    assert.equal(player.lastChat, raw);

    const display = title(player, known[1], known[2], 75);
    assert.equal(display.text.rawtext[0].translate, keyFor(known[1]));
    assert.equal(display.options.subtitle.rawtext[0].translate, keyFor(known[2]));
    assert.deepEqual([display.options.fadeInDuration, display.options.stayDuration, display.options.fadeOutDuration], [5, 75, 12]);
    assert.equal(title(player, known[1]).options.subtitle, '');
    const nativeSubtitle = { rawtext: [{ text: 'no registered translation' }] };
    assert.equal(title(player, known[1], nativeSubtitle).options.subtitle, nativeSubtitle);

    setHook((...args) => args);
    const [recipient, rawTitle, rawOptions] = title(player, known[1], known[2], 75);
    assert.equal(recipient, player);
    assert.equal(rawTitle, known[1]);
    assert.equal(rawOptions.subtitle, known[2]);
    assert.equal(rawOptions.stayDuration, 75);
}

module.exports = { checkForwardedDisplaySinks };
