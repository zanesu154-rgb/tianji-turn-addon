/* ================================================================
 *  world/leveldb.js —— Mojang LevelDB（基岩版存档 db/ 文件夹）读写
 *
 *  读：MANIFEST（当前有效的 .ldb 列表、序列号）→ 所有 .ldb 表 + .log 日志
 *      → 每个键取序列号最大的版本（删除记录会屏蔽旧值）
 *  写：不改动任何 .ldb，只在当前 .log 末尾追加一条 WriteBatch。
 *      游戏打开存档时会重放日志，新值覆盖旧值。这是 LevelDB 正常的写入方式。
 *
 *  压缩：Mojang 版用 zlib（类型 2）和 raw deflate（类型 4）。
 *  解压函数由外部提供（浏览器 DecompressionStream / Node zlib）：
 *      NS.inflate(bytes, 'deflate' | 'deflate-raw') → Promise<Uint8Array>
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n = root.AddonI18n || {};
    const BLOCK = 32768;
    const HEADER = 7;

    // ---------------- 基础 ----------------
    function varint(b, p) {
        let result = 0, shift = 0, byte;
        do {
            byte = b[p++];
            result += (byte & 0x7f) * Math.pow(2, shift);
            shift += 7;
        } while (byte & 0x80);
        return [result, p];
    }
    function putVarint(arr, v) {
        while (v >= 0x80) { arr.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
        arr.push(v);
    }
    function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
    function u64(b, p) { return BigInt(u32(b, p)) | (BigInt(u32(b, p + 4)) << 32n); }

    // CRC32C（Castagnoli）
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
            t[i] = c >>> 0;
        }
        return t;
    })();
    function crc32c(bytes, init = 0) {
        let c = (init ^ 0xffffffff) >>> 0;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    function maskCrc(c) { return ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0; }

    const hex = (u8) => Array.from(u8, x => x.toString(16).padStart(2, '0')).join('');
    const unhex = (s) => Uint8Array.from(s.match(/../g) || [], h => parseInt(h, 16));

    async function inflate(bytes, kind) {
        if (NS.inflate) return NS.inflate(bytes, kind);
        const ds = new DecompressionStream(kind);
        const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
        return new Uint8Array(await out.arrayBuffer());
    }

    // ---------------- 日志文件（.log / MANIFEST） ----------------
    /** 读出日志里的完整记录（拼接 FIRST/MIDDLE/LAST 分片） */
    function readLogRecords(b) {
        const records = [];
        let pending = null;
        let p = 0;
        while (p + HEADER <= b.length) {
            const left = BLOCK - (p % BLOCK);
            if (left < HEADER) { p += left; continue; }
            const len = b[p + 4] | (b[p + 5] << 8);
            const type = b[p + 6];
            if (type === 0 && len === 0) { p += left; continue; }   // 块尾填充
            const data = b.subarray(p + HEADER, p + HEADER + len);
            if (p + HEADER + len > b.length) break;                 // 截断的尾部
            if (type === 1) records.push(data);
            else if (type === 2) pending = [data];
            else if (type === 3) { if (pending) pending.push(data); }
            else if (type === 4) {
                if (pending) {
                    pending.push(data);
                    const total = pending.reduce((a, x) => a + x.length, 0);
                    const all = new Uint8Array(total);
                    let o = 0;
                    for (const x of pending) { all.set(x, o); o += x.length; }
                    records.push(all);
                }
                pending = null;
            }
            p += HEADER + len;
        }
        return { records, end: p };
    }

    /** 生成追加到日志末尾的字节（按 32KB 块切片，带 CRC） */
    function encodeLogRecord(existingLength, payload) {
        const out = [];
        let pos = existingLength;
        let off = 0;
        let first = true;
        while (true) {
            let left = BLOCK - (pos % BLOCK);
            if (left < HEADER) {
                for (let i = 0; i < left; i++) out.push(0);
                pos += left;
                left = BLOCK;
            }
            const avail = left - HEADER;
            const n = Math.min(avail, payload.length - off);
            const last = off + n === payload.length;
            const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
            const chunk = payload.subarray(off, off + n);
            const crc = maskCrc(crc32c(chunk, crc32c(Uint8Array.of(type))));
            out.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24, n & 0xff, n >>> 8, type);
            for (let i = 0; i < chunk.length; i++) out.push(chunk[i]);
            pos += HEADER + n;
            off += n;
            first = false;
            if (last) break;
        }
        return Uint8Array.from(out);
    }

    /** WriteBatch：seq(8) count(4) [type, key, value]… */
    function parseWriteBatch(rec) {
        const seq = u64(rec, 0);
        const count = u32(rec, 8);
        const ops = [];
        let p = 12;
        for (let i = 0; i < count && p < rec.length; i++) {
            const type = rec[p++];
            let kl, vl;
            [kl, p] = varint(rec, p);
            const key = rec.subarray(p, p + kl); p += kl;
            let value = null;
            if (type === 1) { [vl, p] = varint(rec, p); value = rec.subarray(p, p + vl); p += vl; }
            ops.push({ seq: seq + BigInt(i), type, key, value });
        }
        return { seq, count, ops };
    }

    function encodeWriteBatch(seq, puts) {
        const arr = [];
        const s = BigInt(seq);
        for (let i = 0; i < 8; i++) arr.push(Number((s >> BigInt(8 * i)) & 0xffn));
        const n = puts.length;
        arr.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
        for (const { key, value } of puts) {
            arr.push(1);
            putVarint(arr, key.length); for (const x of key) arr.push(x);
            putVarint(arr, value.length); for (const x of value) arr.push(x);
        }
        return Uint8Array.from(arr);
    }

    // ---------------- MANIFEST ----------------
    function parseManifest(b) {
        const { records } = readLogRecords(b);
        const files = new Map();     // 文件号 → level
        let logNumber = 0, prevLogNumber = 0, nextFile = 0, lastSeq = 0n;
        for (const rec of records) {
            let p = 0;
            while (p < rec.length) {
                let tag;
                [tag, p] = varint(rec, p);
                if (tag === 1) { let l; [l, p] = varint(rec, p); p += l; }
                else if (tag === 2) [logNumber, p] = varint(rec, p);
                else if (tag === 3) [nextFile, p] = varint(rec, p);
                else if (tag === 4) { let v; [v, p] = varint(rec, p); lastSeq = BigInt(v); }
                else if (tag === 5) { let l; [, p] = varint(rec, p); [l, p] = varint(rec, p); p += l; }
                else if (tag === 6) { let num; [, p] = varint(rec, p); [num, p] = varint(rec, p); files.delete(num); }
                else if (tag === 7) {
                    let level, num, l;
                    [level, p] = varint(rec, p); [num, p] = varint(rec, p); [, p] = varint(rec, p);
                    [l, p] = varint(rec, p); p += l; [l, p] = varint(rec, p); p += l;
                    files.set(num, level);
                }
                else if (tag === 9) [prevLogNumber, p] = varint(rec, p);
                else throw new Error(`MANIFEST 中未知字段 ${tag}`);
            }
        }
        return { files, logNumber, prevLogNumber, nextFile, lastSeq };
    }

    // ---------------- SSTable（.ldb） ----------------
    async function readBlock(b, offset, size) {
        const data = b.subarray(offset, offset + size);
        const ctype = b[offset + size];
        if (ctype === 0) return data;
        if (ctype === 2) return inflate(data, 'deflate');
        if (ctype === 4) return inflate(data, 'deflate-raw');
        throw new Error(`不支持的压缩类型 ${ctype}`);
    }

    function blockEntries(blk) {
        const numRestarts = u32(blk, blk.length - 4);
        const end = blk.length - 4 - numRestarts * 4;
        const out = [];
        let p = 0;
        let lastKey = new Uint8Array(0);
        while (p < end) {
            let shared, nonShared, vlen;
            [shared, p] = varint(blk, p); [nonShared, p] = varint(blk, p); [vlen, p] = varint(blk, p);
            const key = new Uint8Array(shared + nonShared);
            key.set(lastKey.subarray(0, shared));
            key.set(blk.subarray(p, p + nonShared), shared);
            p += nonShared;
            out.push({ key, value: blk.subarray(p, p + vlen) });
            p += vlen;
            lastKey = key;
        }
        return out;
    }

    async function readTable(b, onEntry) {
        const f = b.length - 48;
        let p = f;
        let off, size;
        [, p] = varint(b, p); [, p] = varint(b, p);              // metaindex
        [off, p] = varint(b, p); [size, p] = varint(b, p);       // index
        const index = blockEntries(await readBlock(b, off, size));
        for (const { value } of index) {
            let q = 0, o, s;
            [o, q] = varint(value, q); [s, q] = varint(value, q);
            for (const e of blockEntries(await readBlock(b, o, s))) {
                const ik = e.key;
                const userKey = ik.subarray(0, ik.length - 8);
                const tagv = u64(ik, ik.length - 8);
                onEntry(userKey, tagv >> 8n, Number(tagv & 0xffn), e.value);
            }
        }
    }

    // ---------------- 整个数据库 ----------------
    /**
     * @param files Map(文件名 → Uint8Array)，只需 db/ 下的文件（名字不带目录）
     * @returns { get(keyU8), entries(), info }
     */
    async function openDb(files, filter) {
        const current = new TextDecoder().decode(files.get('CURRENT') || new Uint8Array()).trim();
        if (!current || !files.has(current)) throw new Error('db/CURRENT 或 MANIFEST 缺失');
        const man = parseManifest(files.get(current));
        const latest = new Map();   // hex(key) → { seq, type, key, value }
        let maxSeq = man.lastSeq;
        const put = (key, seq, type, value) => {
            if (seq > maxSeq) maxSeq = seq;
            if (filter && !filter(key)) return;     // 只保留需要的键（地形等大数据跳过，省内存）
            const h = hex(key);
            const old = latest.get(h);
            if (!old || seq > old.seq) latest.set(h, { seq, type, key: key.slice(), value: value ? value.slice() : null });
            if (seq > maxSeq) maxSeq = seq;
        };
        for (const num of man.files.keys()) {
            const name = String(num).padStart(6, '0') + '.ldb';
            const alt = String(num).padStart(6, '0') + '.sst';
            const b = files.get(name) || files.get(alt);
            if (!b) throw new Error(`缺少数据文件 ${name}`);
            await readTable(b, put);
        }
        // 日志：编号 ≥ log_number 的都要重放
        const logs = [...files.keys()].filter(n => /^\d+\.log$/.test(n)).map(n => [parseInt(n, 10), n])
            .filter(([num]) => num >= man.logNumber || (man.prevLogNumber && num === man.prevLogNumber)).sort((a, b) => a[0] - b[0]);
        for (const [, name] of logs) {
            for (const rec of readLogRecords(files.get(name)).records) {
                if (rec.length < 12) continue;
                for (const op of parseWriteBatch(rec).ops) put(op.key, op.seq, op.type, op.value);
            }
        }
        const live = [...latest.values()].filter(e => e.type === 1);
        const currentLog = logs.length ? logs[logs.length - 1][1] : null;
        return {
            info: { manifest: current, logNumber: man.logNumber, lastSeq: maxSeq, currentLog, tables: man.files.size, keys: live.length },
            entries: () => live,
            get: (key) => { const e = latest.get(hex(key)); return e && e.type === 1 ? e.value : null; },
        };
    }

    /**
     * 生成追加了修改的日志文件内容。
     * @param files   db 文件 Map
     * @param db      openDb 的结果
     * @param puts    [{ key, value }]
     * @returns { name, bytes }  新的日志文件（替换原文件）
     */
    function appendPuts(files, db, puts) {
        if (!puts.length) return null;
        let name = db.info.currentLog;
        let base = name ? files.get(name) : new Uint8Array(0);
        if (!name) name = String(db.info.logNumber).padStart(6, '0') + '.log';
        // 只保留可解析的部分，截掉可能的半截尾巴
        const { end } = readLogRecords(base);
        base = base.subarray(0, Math.min(end, base.length));
        const seq = db.info.lastSeq + 1n;
        const rec = encodeLogRecord(base.length, encodeWriteBatch(seq, puts));
        const out = new Uint8Array(base.length + rec.length);
        out.set(base);
        out.set(rec, base.length);
        return { name, bytes: out };
    }

    NS.LevelDB = { openDb, appendPuts, readLogRecords, parseWriteBatch, parseManifest, crc32c, maskCrc, hex, unhex, varint };
})(typeof globalThis !== 'undefined' ? globalThis : this);
