/* ================================================================
 *  util.js —— 通用工具：文本判定、键名、lang 读写、宽松 JSON 解析
 *  所有模块挂在 globalThis.AddonI18n 上，浏览器 / Node 通用
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n = root.AddonI18n || {};

    // ---------------------------------------------------------------
    //  文本判定
    // ---------------------------------------------------------------

    const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/;

    /** 去掉 § 格式码 */
    function stripFormatting(s) {
        return String(s).replace(/§./g, '');
    }

    function hasCJK(s) {
        return CJK_RE.test(s);
    }

    /** 去掉格式码后是否含有任意文字（字母/汉字等） */
    function hasLetters(s) {
        return /\p{L}/u.test(stripFormatting(s));
    }

    /** 只有问号、感叹号、省略号的句子（"???"、"!!"、"..."、"？！"）：各语言写法不同（？？？ / ¿¡），显示位置照样翻译 */
    function isPunctText(s) {
        const t = stripFormatting(String(s)).replace(/\s+/g, '');
        return /^[?!？！.。…‽¿¡~～]{1,12}$/.test(t) && /[?!？！…‽]|\.\.\./.test(t);
    }

    /** 用下划线连起来的词（"Spawnpoint_Save"、"Level_1_Complete"）：放在命令显示位置时是给玩家看的文字 */
    function isUnderscoreWords(s) {
        const t = stripFormatting(String(s)).trim();
        if (!/^[\p{L}\d]+(?:_[\p{L}\d]+)+$/u.test(t)) return false;
        const segs = t.split('_').filter(x => /\p{L}/u.test(x));
        return segs.length >= 2 && segs.some(x => /\p{L}{3,}/u.test(x));
    }

    /** 命令显示位置（title / tellraw / say）里可以不像句子、但仍然是给玩家看的文字 */
    function isShownText(s) {
        return isPunctText(s) || isUnderscoreWords(s);
    }

    function isEmptyText(s) {
        return typeof s !== 'string' || s.trim() === '';
    }

    /**
     * 看起来是否已经是本地化键（如 item.apple.name / gui.ok / pack.name）。
     * knownKeys：附加包里已存在的 lang 键集合，命中则必定是键。
     */
    function isLikelyKey(s, knownKeys) {
        if (typeof s !== 'string') return false;
        const t = s.trim();
        if (!t) return false;
        if (knownKeys && knownKeys.has(t)) return true;
        if (/\s/.test(t) || hasCJK(t) || t.includes('§')) return false;
        // 允许带重音的拉丁字母（如 déesse.extPacks.title）
        if (!/^[\p{L}\p{N}_\-:]+(\.[\p{L}\p{N}_\-:]+)+$/u.test(t)) return false;
        // 版本号 / 小数
        if (/^[\d.]+$/.test(t)) return false;
        // 文件名
        if (/\.(png|jpe?g|tga|json|js|mjs|ogg|wav|fsb|mcfunction|lang|material)$/i.test(t)) return false;
        // 每一段至少要有字母
        return t.split('.').filter(seg => /\p{L}/u.test(seg)).length >= 2;
    }

    /** 看起来像技术标识符 / 路径 / 代码，而不是给玩家看的文字 */
    function looksLikeCode(s) {
        const t = stripFormatting(s).trim();
        if (!t) return true;
        if (hasCJK(t)) {
            // 含中文也可能是路径
            return /^[\w\-./一-鿿]+\.(png|json|js|ogg|wav)$/.test(t);
        }
        if (/^@[aeprsvn](\[|$)/.test(t)) return true;                  // 选择器
        if (/^https?:\/\//i.test(t)) return true;                      // URL
        if (/^[\w.-]+:[\w./-]+$/.test(t)) return true;                // 命名空间 id
        if (/^(textures|sounds|ui|texts|models|scripts|animations|functions|structures|loot_tables|trading)\//i.test(t)) return true;
        if (/\.(png|jpe?g|tga|json|js|mjs|ogg|wav|fsb|mcfunction|lang)$/i.test(t)) return true;
        if (/^[a-z0-9_]+$/.test(t)) return true;                       // snake_case / 单个小写词
        if (/^[A-Z0-9_]+$/.test(t) && t.length > 1 && t.includes('_')) return true; // CONST_CASE
        if (/^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$/.test(t)) return true;     // 带下划线的标识符（PONDERING_BOOK_tether）
        if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t)) return true;          // camelCase
        if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(t)) return true;       // a.b.c
        if (/^[#$]/.test(t)) return true;                              // UI 绑定 / 变量
        if (/^[{[].*[}\]]$/s.test(t)) {                                // JSON（"[Info] 文字 [x]" 这种不算）
            try { JSON.parse(t); return true; } catch (e) { if (/^\{\s*"/.test(t)) return true; }
        }
        // 代码特征；英文里的 “fails to function”、“return to base” 不算
        if (/=>|\bfunction\s*[\w$]*\s*\(|\breturn\s+[\w$.()[\]'"]+\s*;|;\s*$/.test(t)) return true;
        if (/^q\.|^query\.|^v\.|^variable\.|^math\./.test(t)) return true; // Molang
        // 不在开头的 Molang："!query.is_alive || (v.a ?? 0) > 0"：带 query.x / v.x 且有运算符
        if (/\b(?:q|v|t|c|query|variable|temp|context|math)\.[a-z_]\w*/.test(t) && /\|\||&&|[<>!=]=|\?\?|[<>]\s*\d|^!|\?\s*[\w.('"]+\s*:/.test(t)) return true;
        // 竖线分隔的数据记录："adaptive|Rapid Adaptation|p|duration|60"：至少三段，有一段是数字或小写标识符
        if (/^[^|\s][^|]*(\|[^|]*){2,}$/.test(t) && !/\s\|\s/.test(t)) {
            const parts = t.split('|');
            if (parts.some(x => /^-?\d+(\.\d+)?$/.test(x)) || parts.filter(x => /^[a-z][a-zA-Z0-9_]*$/.test(x)).length >= 2) return true;
        }
        return false;
    }

    /**
     * 是否是玩家可见、值得翻译的文本
     * mode = 'loose'  ：已确定是显示位置（如 form.title 的参数）—— 只排除明显的代码
     * mode = 'strict' ：不确定用途（如脚本里任意字符串）—— 需要更像自然语言
     */
    /** 去掉 "%stats.total"、"%item.runecraft" 这类键引用（游戏显示时按键翻译）；%1$s、%s 不算 */
    const KEY_REF_RE = /%(?![sd]\b)[A-Za-z_][\w:-]*(?:\.[\w:-]+)+/g;
    function stripKeyRefs(s) {
        return String(s).replace(KEY_REF_RE, ' ');
    }
    function hasKeyRefs(s) {
        KEY_REF_RE.lastIndex = 0;
        const r = KEY_REF_RE.test(String(s));
        KEY_REF_RE.lastIndex = 0;
        return r;
    }

    function looksLikeText(s, mode = 'loose') {
        if (typeof s !== 'string') return false;
        // "%menu.serverGenericName" 这类是游戏内的键引用，显示时自动翻译；去掉后没剩文字 → 不是待提取的文本
        const plain = stripKeyRefs(stripFormatting(s)).trim();
        if (!plain) return false;
        if (!hasLetters(plain)) return false;
        if (hasCJK(plain)) return !looksLikeCode(plain);
        if (looksLikeCode(plain)) return false;
        if (mode === 'loose') return true;
        // strict：多个单词，或首字母大写的单词
        if (/\s/.test(plain) && /\p{L}{2,}/u.test(plain)) return true;
        // 单个首字母大写的词；带冒号的是标签（"Requires:"、"Missing:"）
        if (/^\p{Lu}[\p{L}'’-]{2,}[!?.:：]?$/u.test(plain)) return true;
        return false;
    }

    // ---------------------------------------------------------------
    //  键名
    // ---------------------------------------------------------------

    function hash6(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h.toString(36).slice(0, 6);
    }

    /** 清理成合法键名片段：只保留 A-Z a-z 0-9 _ . : - */
    function sanitizeKeyPart(s) {
        const raw = String(s);
        let out = raw.replace(/[^A-Za-z0-9_.:\-]/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '');
        // 大部分字符被替换（中文文件名等）→ 加哈希避免全部撞成 "_"
        if (!out || out.replace(/_/g, '').length < raw.length / 2) {
            out = (out ? out + '_' : 'x') + hash6(raw);
        }
        return out;
    }

    function sanitizeKey(key) {
        return String(key).split('.').map(p => p === '' ? '_' : p.replace(/[^A-Za-z0-9_:\-]/g, '_')).join('.');
    }

    function fileBaseOf(path) {
        const name = path.split('/').pop();
        return sanitizeKeyPart(name.replace(/\.[^.]+$/, '').replace(/\.(item|block|entity|bp|rp|ac|anim|animation|dialogue)$/i, ''));
    }

    /** 由 namespace:id 推测一个英文显示名（用于缺失名称的占位） */
    function humanizeIdentifier(id) {
        const name = String(id).split(':').pop();
        return name.split(/[_\-.]+/).filter(Boolean)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    // ---------------------------------------------------------------
    //  lang 读写
    // ---------------------------------------------------------------

    function stripBOM(s) {
        return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }

    /** 解析 .lang：支持 ## 注释、行内 ## / \t# 注释、BOM、CRLF */
    function parseLang(content) {
        const map = new Map();
        if (!content) return map;
        for (let line of stripBOM(content).split('\n')) {
            line = line.replace(/\r$/, '');
            const t = line.trimStart();
            if (!t || t.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.substring(0, eq).trim();
            let value = line.substring(eq + 1);
            const c1 = value.indexOf('##');
            const c2 = value.indexOf('\t#');
            const cut = [c1, c2].filter(i => i >= 0);
            if (cut.length) value = value.substring(0, Math.min(...cut));
            if (key) map.set(key, value);
        }
        return map;
    }

    /**
     * 每个键在 .lang 里的注释：所在分节（上方最近的一段 # 注释行）和行尾注释（\t# / ##）
     * 补全到其他语言时一起带过去，译者能看到“这是方块”“显示在物品栏”之类的提示
     */
    function langNotes(content, skipMark) {
        const notes = new Map();
        if (!content) return notes;
        let section = null, block = [], lastWasComment = false;
        for (let line of stripBOM(content).split('\n')) {
            line = line.replace(/\r$/, '');
            const t = line.trimStart();
            if (!t) { lastWasComment = false; continue; }
            if (t.startsWith('#')) {
                if (skipMark && t.startsWith(skipMark)) { section = null; block = []; lastWasComment = false; continue; }
                if (!lastWasComment) block = [];
                block.push(line.trimEnd());
                section = block.join('\n');
                lastWasComment = true;
                continue;
            }
            lastWasComment = false;
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.substring(0, eq).trim();
            const value = line.substring(eq + 1);
            const cut = [value.indexOf('##'), value.indexOf('\t#')].filter(i => i >= 0);
            const tail = cut.length ? value.substring(Math.min(...cut)).trimEnd() : '';
            if (key && !notes.has(key)) notes.set(key, { section, tail });
        }
        return notes;
    }

    /**
     * 把文本转换成 lang 值：
     *  - 真换行 → \n（lang 值不能包含真换行）
     *  - ## 和 \t# 会被游戏当作注释，做规避
     */
    /**
     * 同一条里混用 %1$s 和 %s 时游戏不认带序号的（显示成 “%3”）。
     * 把不带序号的 %s / %d 按顺序补成没用到的序号：
     *   "使用 %3$s 需要 %s %s" → "使用 %3$s 需要 %1$s %2$s"
     * 返回 null 表示不需要改。
     */
    function fixMixedPlaceholders(value) {
        const s = String(value).replace(/%%/g, '\u0000');
        const pos = [...s.matchAll(/%(\d+)\$[sd]/g)].map(m => +m[1]);
        if (!pos.length || !/%[sd]/.test(s)) return null;
        const used = new Set(pos);
        let next = 1;
        const out = s.replace(/%(\d+\$)?([sd])/g, (all, n, t) => {
            if (n) return all;
            while (used.has(next)) next++;
            used.add(next);
            return `%${next}$${t}`;
        });
        return out.replace(/\u0000/g, '%%');
    }

    /**
     * 百分号：游戏的 lang 值带参数（%1$s）时按格式字符串解析，字面的 % 要写成 %%；不带参数时原样显示。
     * 脚本作者为了让界面显示一个 %，常在字符串里写 %%（已经转义过）。
     *  - pctArgs：带参数的值。单个 % → %%，已有的 %% 保持（之前会变成 %%%%，游戏里显示成 %%）
     *  - pctPlain：不带参数的值。%% → %（后面跟 s / d / 数字 / . 的保留，免得被当成占位符）
     */
    function pctArgs(s) { return s.replace(/%%|%/g, '%%'); }
    function pctPlain(s) { return s.replace(/%%(?![sd0-9.$])/g, '%'); }

    function toLangValue(text) {
        return String(text)
            .replace(/\r\n?/g, '\n')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '    ')
            .replace(/##/g, '#​#');
    }

    // ---------------------------------------------------------------
    //  宽松 JSON 解析（注释、尾逗号、BOM）
    // ---------------------------------------------------------------

    function stripJsonCommentsAndCommas(src) {
        let out = '';
        let i = 0;
        const n = src.length;
        let inStr = false;
        while (i < n) {
            const c = src[i];
            if (inStr) {
                out += c;
                if (c === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
                if (c === '"') inStr = false;
                i++;
                continue;
            }
            if (c === '"') { inStr = true; out += c; i++; continue; }
            if (c === '/' && src[i + 1] === '/') {
                while (i < n && src[i] !== '\n') i++;
                continue;
            }
            if (c === '/' && src[i + 1] === '*') {
                i += 2;
                while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
                i += 2;
                continue;
            }
            if (c === ',') {
                // 尾逗号：后面只有空白再接 } 或 ]
                let j = i + 1;
                while (j < n && /\s/.test(src[j])) j++;
                if (src[j] === '}' || src[j] === ']') { i++; continue; }
            }
            out += c;
            i++;
        }
        return out;
    }

    /**
     * 记下原文里写成小数的整数（"default": 1.0、"range": [0.0, 4.0]）：JSON.parse 之后它们和 1、4 分不出来，
     * 写回时会变成整数。实体属性 "type": "float" 写成整数时游戏会判定定义无效，后面的属性也一起没了，
     * 所以写回时要保持小数写法。按路径记（同一个文件里别处真正的整数不受影响）
     */
    const floatPaths = new WeakMap();
    function recordFloatPaths(obj, text) {
        if (!obj || typeof obj !== 'object' || !/\d\.0*[\s,\]}]|\d[eE]/.test(text)) return obj;
        const set = new Set();
        const stack = [];   // { arr: bool, idx, key }
        let i = 0, pendingKey = null;
        const pathNow = () => stack.map(f => f.arr ? f.idx : f.key).join('\u0001');
        const n = text.length;
        while (i < n) {
            const c = text[i];
            if (c === '"') {
                let j = i + 1;
                while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
                const str = text.slice(i, j + 1);
                i = j + 1;
                let k = i; while (k < n && /\s/.test(text[k])) k++;
                if (text[k] === ':' && stack.length && !stack[stack.length - 1].arr) { try { pendingKey = JSON.parse(str); } catch (e) { pendingKey = str.slice(1, -1); } }
                continue;
            }
            if (c === '{' || c === '[') {
                if (stack.length) { const top = stack[stack.length - 1]; if (!top.arr) top.key = pendingKey; }
                stack.push({ arr: c === '[', idx: 0, key: null });
                i++; continue;
            }
            if (c === '}' || c === ']') { stack.pop(); i++; continue; }
            if (c === ',') { const top = stack[stack.length - 1]; if (top && top.arr) top.idx++; i++; continue; }
            if (c === '-' || (c >= '0' && c <= '9')) {
                const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
                if (m) {
                    if ((m[1] || m[2]) && Number.isInteger(Number(m[0]))) {
                        const top = stack[stack.length - 1];
                        if (top && !top.arr) top.key = pendingKey;
                        set.add(pathNow());
                    }
                    i += m[0].length; continue;
                }
            }
            i++;
        }
        if (set.size) floatPaths.set(obj, set);
        return obj;
    }

    /** 写回 JSON：按 recordFloatPaths 记下的位置保留 1.0 这类小数写法 */
    function stringifyJson(obj, indent = 2) {
        const set = obj && typeof obj === 'object' ? floatPaths.get(obj) : null;
        if (!set) return JSON.stringify(obj, null, indent);
        const paths = new WeakMap();
        const MARK = '\u0000F';
        const out = JSON.stringify(obj, function (key, value) {
            const base = this === undefined || key === '' ? null : paths.get(this);
            const p = key === '' ? '' : (base ? base + '\u0001' : '') + key;
            if (value && typeof value === 'object') { paths.set(value, p); return value; }
            if (typeof value === 'number' && Number.isInteger(value) && set.has(p)) return MARK + value;
            return value;
        }, indent);
        return out.replace(/"\\u0000F(-?\d+)"/g, '$1.0');
    }

    function parseJsonLenient(content) {
        const r = parseJsonLenientRaw(content);
        if (r && typeof r === 'object') { try { recordFloatPaths(r, stripJsonCommentsAndCommas(stripBOM(content))); } catch (e) { /* 记不下来就按整数写 */ } }
        return r;
    }

    function parseJsonLenientRaw(content) {
        const s = stripBOM(content);
        try { return JSON.parse(s); } catch (e) { /* 继续 */ }
        try { return JSON.parse(stripJsonCommentsAndCommas(s)); } catch (e) { /* 继续 */ }
        if (root.JSON5) {
            try { return root.JSON5.parse(s); } catch (e) { /* 继续 */ }
        }
        // 根对象后面多了东西（常见：多写了一个 }）：游戏只读第一个完整的对象，这里也一样
        const head = firstJsonValue(stripJsonCommentsAndCommas(s));
        if (head) {
            try { return JSON.parse(head); } catch (e) { /* 继续 */ }
            if (root.JSON5) { try { return root.JSON5.parse(head); } catch (e) { /* 放弃 */ } }
        }
        return undefined;
    }

    /** 取出文本开头第一个完整的 {…} / […]（跳过字符串里的括号）；后面没有多余内容时返回 null */
    function firstJsonValue(t) {
        const start = t.search(/[{[]/);
        if (start < 0) return null;
        let depth = 0, inStr = false;
        for (let i = start; i < t.length; i++) {
            const c = t[i];
            if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
            if (c === '"') inStr = true;
            else if (c === '{' || c === '[') depth++;
            else if (c === '}' || c === ']') { if (--depth === 0) return /\S/.test(t.slice(i + 1)) ? t.slice(start, i + 1) : null; }
        }
        return null;
    }

    // ---------------------------------------------------------------
    //  正则转义
    // ---------------------------------------------------------------

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    Object.assign(NS, {
        stripFormatting, hasCJK, hasLetters, isPunctText, isUnderscoreWords, isShownText, isEmptyText, isLikelyKey,
        looksLikeCode, looksLikeText, stripKeyRefs, hasKeyRefs,
        hash6, sanitizeKeyPart, sanitizeKey, fileBaseOf, humanizeIdentifier,
        stripBOM, parseLang, langNotes, toLangValue, fixMixedPlaceholders, pctArgs, pctPlain,
        stripJsonCommentsAndCommas, parseJsonLenient, stringifyJson, escapeRegex,
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
