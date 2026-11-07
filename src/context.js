/* ================================================================
 *  context.js —— 提取上下文：分配键、去重、记录报告
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;
    const { looksLikeText, isLikelyKey, sanitizeKey, isEmptyText } = NS;

    // JS 模板字符串里的动态部分在命令处理时用这些私有区字符占位
    //   n  ：原样还原为 ${expr}
    //   n  ：还原为 ${JSON转义(expr)}（从纯文本搬进了 JSON 字符串）
    const SENTINEL_RE = /(\d+)|(\d+)/g;

    class ExtractContext {
        constructor(options = {}) {
            this.knownKeys = options.knownKeys || new Set();         // 附加包中已有的所有 lang 键
            this.existingValues = options.existingValues || new Map(); // 源语言 lang 中已有的 键→值
            this.splitNewlines = options.splitNewlines !== false;
            this.entries = new Map();      // 新键 → { value, file, kind }
            this.used = new Set(this.knownKeys);
            this.dedupe = new Map();
            this.referenced = new Map();   // 引用到的已有键 → 文件
            this.untranslatable = [];      // { file, where, text, reason }
            this.warnings = [];
            this.inputTables = [];         // 玩家输入匹配（聊天关键词/正则），只导出
            this.translations = new Map(); // 键 → Map(语言 → 已有译文)，来自脚本自带的多语言表
            this.packEntries = new Map();  // 包根目录 → Map(键→值)，用于 pack.name / pack.description
            this.stats = { files: 0 };
        }

        /**
         * 为文本分配键。
         * baseKey : 期望的键名
         * scope   : 去重范围；同一 scope 下相同文本复用同一个键。null = 不去重
         */
        alloc(baseKey, text, { file = '', kind = '', scope = null } = {}) {
            const base = sanitizeKey(baseKey);
            if (scope) {
                const d = this.dedupe.get(scope + '\u0000' + text);
                if (d) return d;
            }
            let key;
            // 附加包里已有这个键且值相同 → 直接复用
            const ev = this.existingValues.get(base);
            const evList = ev instanceof Set ? [...ev] : (ev != null ? [ev] : []);
            if (evList.includes(text)) {
                key = base;
            } else if (evList.length && evList.every(v => NS.hasCJK(v) !== NS.hasCJK(text)) && !this.entries.has(base)) {
                // 已有键的值是另一种文字（如 en_US 的 "Altar" 对应 "祭坛"）→ 视为同一条的译文，复用键，
                // 原文只会补进缺少该键的语言文件
                key = base;
                this.entries.set(key, { value: text, file, kind });
            } else {
                key = base;
                let i = 1;
                while (this.used.has(key)) key = `${base}_${i++}`;
                this.used.add(key);
                this.entries.set(key, { value: text, file, kind });
            }
            if (scope) this.dedupe.set(scope + '\u0000' + text, key);
            return key;
        }

        addTranslation(key, lang, value) {
            if (!this.translations.has(key)) this.translations.set(key, new Map());
            const m = this.translations.get(key);
            if (!m.has(lang)) m.set(lang, value);
        }

        ref(key, file) {
            if (typeof key === 'string' && !this.referenced.has(key)) this.referenced.set(key, file);
        }

        report(file, where, text, reason) {
            if (isEmptyText(text)) return;
            this.untranslatable.push({ file, where, text, reason });
        }

        warn(msg) {
            this.warnings.push(msg);
        }

        setPackEntry(packRoot, key, value) {
            if (!this.packEntries.has(packRoot)) this.packEntries.set(packRoot, new Map());
            this.packEntries.get(packRoot).set(key, value);
        }

        isKey(s) {
            return isLikelyKey(s, this.knownKeys);
        }

        /**
         * 把一段文本变成 rawtext 节点数组。
         *  - 首尾的格式码 / 空白单独保留为 {text}
         *  - 按需把换行拆成多个键（lang 值不能含真换行）
         *  - 文本里有动态占位符时生成 translate + with
         * 返回 null 表示不需要翻译。
         */
        rawParts(text, baseKey, meta = {}) {
            if (typeof text !== 'string') return null;
            const hasSentinel = /\d+|\d+/.test(text);
            const literalOnly = text.replace(SENTINEL_RE, ' ');
            // mode 'display'：已确定是给玩家看的位置（告示牌、NPC 对话），只要有文字就翻译
            const textOk = (t) => meta.mode === 'display' ? NS.hasLetters(t) : looksLikeText(t, meta.mode || 'loose');
            if (!textOk(literalOnly)) return null;
            if (!hasSentinel && this.isKey(text)) { this.ref(text.trim(), meta.file); return null; }

            const nodes = [];
            const m = /^((?:§.|\s)*)([\s\S]*?)((?:§.|\s)*)$/.exec(text);
            const lead = m[1], body = m[2], tail = m[3];
            if (lead) nodes.push({ text: lead });

            if (hasSentinel) {
                const args = [];
                let n = 0;
                const value = body.replace(/%/g, '%%').replace(SENTINEL_RE, (s) => {
                    args.push({ text: s });
                    return `%${++n}$s`;
                });
                const key = this.alloc(baseKey, value, meta);
                nodes.push({ translate: key, with: { rawtext: args } });
            } else {
                const lines = this.splitNewlines && !meta.noSplit ? body.split(/\r?\n/) : [body];
                lines.forEach((line, i) => {
                    if (i > 0) nodes.push({ text: '\n' });
                    if (!line) return;
                    if (textOk(line)) {
                        nodes.push({ translate: this.alloc(baseKey, line, meta) });
                    } else {
                        nodes.push({ text: line });
                    }
                });
            }
            if (tail) nodes.push({ text: tail });
            return nodes;
        }

        /**
         * 递归处理一个 RawMessage 对象（{rawtext:[...]}），把 text 节点改成 translate。
         * 原地修改，返回是否有改动。
         */
        processRawMessage(msg, baseKey, meta = {}) {
            if (!msg || typeof msg !== 'object') return false;
            let changed = false;
            if (typeof msg.translate === 'string') this.ref(msg.translate, meta.file);
            if (msg.with && typeof msg.with === 'object' && !Array.isArray(msg.with)) {
                if (this.processRawMessage(msg.with, baseKey, meta)) changed = true;
            }
            if (Array.isArray(msg.rawtext)) {
                const out = [];
                for (const node of msg.rawtext) {
                    if (node && typeof node === 'object' && typeof node.text === 'string'
                        && Object.keys(node).length === 1) {
                        const parts = this.rawParts(node.text, baseKey, meta);
                        if (parts) { out.push(...parts); changed = true; continue; }
                    } else if (node && typeof node === 'object') {
                        if (this.processRawMessage(node, baseKey, meta)) changed = true;
                    }
                    out.push(node);
                }
                if (changed) msg.rawtext = out;
            }
            return changed;
        }
    }

    NS.ExtractContext = ExtractContext;
    NS.SENTINEL_RE = SENTINEL_RE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
