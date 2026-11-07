/* ================================================================
 *  world/nbt.js —— 基岩版小端 NBT 读写
 *  解析结果保留类型和顺序，写回时字节级一致（未改动的字符串原样输出）
 *  节点：{ t: 类型, n: 名字, v: 值 }   列表：v = { et: 元素类型, items: [...] }
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n = root.AddonI18n || {};
    const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };
    const dec = new TextDecoder('utf-8');
    const enc = new TextEncoder();

    class Reader {
        constructor(bytes, off = 0) { this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = off; }
        u8() { return this.b[this.p++]; }
        i16() { const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
        u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
        i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
        i64() { const v = this.dv.getBigInt64(this.p, true); this.p += 8; return v; }
        f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
        f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
        bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
        str() {
            const n = this.u16();
            const raw = this.bytes(n);
            return { s: dec.decode(raw), raw };
        }
    }

    function readPayload(r, t) {
        switch (t) {
            case T.BYTE: return r.dv.getInt8(r.p++);
            case T.SHORT: return r.i16();
            case T.INT: return r.i32();
            case T.LONG: return r.i64();
            case T.FLOAT: return r.f32();
            case T.DOUBLE: return r.f64();
            case T.BYTE_ARRAY: { const n = r.i32(); return r.bytes(n).slice(); }
            case T.STRING: { const { s, raw } = r.str(); return new NbtString(s, raw); }
            case T.LIST: {
                const et = r.u8(), n = r.i32();
                const items = [];
                for (let i = 0; i < n; i++) items.push(readPayload(r, et));
                return { et, items };
            }
            case T.COMPOUND: {
                const out = [];
                for (;;) {
                    const ct = r.u8();
                    if (ct === T.END) break;
                    const name = r.str();
                    out.push({ t: ct, n: name.s, nraw: name.raw, v: readPayload(r, ct) });
                }
                return out;
            }
            case T.INT_ARRAY: { const n = r.i32(); const a = []; for (let i = 0; i < n; i++) a.push(r.i32()); return a; }
            case T.LONG_ARRAY: { const n = r.i32(); const a = []; for (let i = 0; i < n; i++) a.push(r.i64()); return a; }
            default: throw new Error(`未知 NBT 类型 ${t} @${r.p}`);
        }
    }

    /** 字符串值：记住原始字节，未修改时原样写回 */
    class NbtString {
        constructor(s, raw) { this.s = s; this.raw = raw; }
        toString() { return this.s; }
    }

    /** 读一个根标签 */
    function readRoot(r) {
        const t = r.u8();
        if (t === T.END) return null;
        const name = r.str();
        return { t, n: name.s, nraw: name.raw, v: readPayload(r, t) };
    }

    /** 读取连续的多个根标签（方块实体记录就是这样拼接的） */
    function readAll(bytes) {
        const r = new Reader(bytes);
        const out = [];
        while (r.p < bytes.length) {
            const tag = readRoot(r);
            if (!tag) break;
            out.push(tag);
        }
        return out;
    }

    // ---------------- 写 ----------------
    class Writer {
        constructor() { this.parts = []; this.len = 0; }
        push(u8) { this.parts.push(u8); this.len += u8.length; }
        u8(v) { this.push(Uint8Array.of(v & 0xff)); }
        num(size, fn) { const b = new Uint8Array(size); fn(new DataView(b.buffer)); this.push(b); }
        str(s, raw) {
            const bytes = raw || enc.encode(s);
            this.num(2, dv => dv.setUint16(0, bytes.length, true));
            this.push(bytes);
        }
        out() { const o = new Uint8Array(this.len); let p = 0; for (const x of this.parts) { o.set(x, p); p += x.length; } return o; }
    }

    function writePayload(w, t, v) {
        switch (t) {
            case T.BYTE: w.num(1, dv => dv.setInt8(0, v)); break;
            case T.SHORT: w.num(2, dv => dv.setInt16(0, v, true)); break;
            case T.INT: w.num(4, dv => dv.setInt32(0, v, true)); break;
            case T.LONG: w.num(8, dv => dv.setBigInt64(0, BigInt(v), true)); break;
            case T.FLOAT: w.num(4, dv => dv.setFloat32(0, v, true)); break;
            case T.DOUBLE: w.num(8, dv => dv.setFloat64(0, v, true)); break;
            case T.BYTE_ARRAY: w.num(4, dv => dv.setInt32(0, v.length, true)); w.push(v); break;
            case T.STRING: {
                if (v instanceof NbtString) w.str(v.s, v.raw && dec.decode(v.raw) === v.s ? v.raw : null);
                else w.str(String(v), null);
                break;
            }
            case T.LIST:
                w.u8(v.et);
                w.num(4, dv => dv.setInt32(0, v.items.length, true));
                for (const it of v.items) writePayload(w, v.et, it);
                break;
            case T.COMPOUND:
                for (const c of v) {
                    w.u8(c.t);
                    w.str(c.n, c.nraw && dec.decode(c.nraw) === c.n ? c.nraw : null);
                    writePayload(w, c.t, c.v);
                }
                w.u8(T.END);
                break;
            case T.INT_ARRAY: w.num(4, dv => dv.setInt32(0, v.length, true)); for (const x of v) w.num(4, dv => dv.setInt32(0, x, true)); break;
            case T.LONG_ARRAY: w.num(4, dv => dv.setInt32(0, v.length, true)); for (const x of v) w.num(8, dv => dv.setBigInt64(0, BigInt(x), true)); break;
            default: throw new Error(`未知 NBT 类型 ${t}`);
        }
    }

    function writeAll(tags) {
        const w = new Writer();
        for (const tag of tags) {
            w.u8(tag.t);
            w.str(tag.n, tag.nraw && dec.decode(tag.nraw) === tag.n ? tag.nraw : null);
            writePayload(w, tag.t, tag.v);
        }
        return w.out();
    }

    // ---------------- 便捷访问 ----------------
    /** 复合标签里按名字取子节点 */
    function child(compound, name) {
        return Array.isArray(compound) ? compound.find(c => c.n === name) : undefined;
    }
    function getStr(compound, name) {
        const c = child(compound, name);
        return c && c.t === T.STRING ? c.v.s : undefined;
    }
    function setStr(compound, name, s) {
        const c = child(compound, name);
        if (c && c.t === T.STRING) c.v = new NbtString(s, null);
        else compound.push({ t: T.STRING, n: name, nraw: null, v: new NbtString(s, null) });
    }

    /** 转成普通 JS 对象（只用于调试/展示） */
    function toPlain(t, v) {
        switch (t) {
            case T.STRING: return v.s;
            case T.LONG: return v.toString() + 'L';
            case T.COMPOUND: return Object.fromEntries(v.map(c => [c.n, toPlain(c.t, c.v)]));
            case T.LIST: return v.items.map(x => toPlain(v.et, x));
            case T.BYTE_ARRAY: return `<${v.length} bytes>`;
            default: return v;
        }
    }

    NS.NBT = { T, Reader, readRoot, readAll, writeAll, NbtString, child, getStr, setStr, toPlain };
})(typeof globalThis !== 'undefined' ? globalThis : this);
