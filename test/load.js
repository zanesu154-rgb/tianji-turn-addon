// 在 Node 中加载浏览器端模块
const path = require('path');
const fs = require('fs');
globalThis.acorn = require('../vendor/acorn.js');
for (const f of ['log-i18n', 'util', 'lang-blacklist', 'minversion', 'vanilla-names', 'context', 'commands', 'json', 'script', 'pipeline', 'world/nbt', 'world/leveldb', 'world/world']) {
    require(path.join(__dirname, '..', 'src', f + '.js'));
}
const zlib = require('zlib');
globalThis.AddonI18n.inflate = async (b, k) => new Uint8Array(k === 'deflate-raw' ? zlib.inflateRawSync(b) : zlib.inflateSync(b));

class MemFS {
    constructor(files) { this.files = new Map(files); }
    list() { return [...this.files.keys()]; }
    async readText(p) {
        const v = this.files.get(p);
        if (v === undefined) throw new Error('no file ' + p);
        return typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
    }
    writeText(p, s) { this.files.set(p, s); }
    async readBytes(p) { const v = this.files.get(p); return typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v); }
    writeBytes(p, b) { this.files.set(p, b); }
    move(a, b) { const v = this.files.get(a); this.files.delete(a); this.files.set(b, v); }
    remove(p) { this.files.delete(p); }
    sizeOf(p) { const v = this.files.get(p); return v == null ? 0 : v.length; }
}

function readDir(dir, prefix = '') {
    const out = new Map();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) for (const [k, v] of readDir(full, rel)) out.set(k, v);
        else out.set(rel, fs.readFileSync(full));
    }
    return out;
}

module.exports = { NS: globalThis.AddonI18n, MemFS, readDir };
