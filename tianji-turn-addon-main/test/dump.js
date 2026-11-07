// 跑一遍管线并把结果写到 test/out/ 便于人工检查
const path = require('path');
const fs = require('fs');
const { NS, MemFS, readDir } = require('./load');

(async () => {
    const dir = process.argv[2] || path.join(__dirname, 'fixture');
    const out = process.argv[3] || path.join(__dirname, 'out');
    const mem = new MemFS(readDir(dir));
    const before = new Map(mem.files);
    const res = await NS.runPipeline(mem, { baseName: 'fixture' }, (m, t) => console.log((t === 'warn' ? '⚠ ' : '  ') + m));
    fs.rmSync(out, { recursive: true, force: true });
    for (const [p, v] of mem.files) {
        const changed = before.get(p) !== v;
        if (!changed) continue;
        const full = path.join(out, p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, v);
    }
    for (const [n, c] of Object.entries(res.workbook)) fs.writeFileSync(path.join(out, '_' + n), c);
    console.log(JSON.stringify(res.summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
