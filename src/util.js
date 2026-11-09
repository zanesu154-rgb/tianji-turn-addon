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
        if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t)) return true;          // camelCase
        if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(t)) return true;       // a.b.c
        if (/^[#$]/.test(t)) return true;                              // UI 绑定 / 变量
        if (/^[{[].*[}\]]$/s.test(t)) {                                // JSON（"[Info] 文字 [x]" 这种不算）
            try { JSON.parse(t); return true; } catch (e) { if (/^\{\s*"/.test(t)) return true; }
        }
        // 代码特征；英文里的 “fails to function”、“return to base” 不算
        if (/=>|\bfunction\s*[\w$]*\s*\(|\breturn\s+[\w$.()[\]'"]+\s*;|;\s*$/.test(t)) return true;
        if (/^q\.|^query\.|^v\.|^variable\.|^math\./.test(t)) return true; // Molang
        return false;
    }

    /**
     * 是否是玩家可见、值得翻译的文本
     * mode = 'loose'  ：已确定是显示位置（如 form.title 的参数）—— 只排除明显的代码
     * mode = 'strict' ：不确定用途（如脚本里任意字符串）—— 需要更像自然语言
     */
    function looksLikeText(s, mode = 'loose') {
        if (typeof s !== 'string') return false;
        // "%menu.serverGenericName" 这类是游戏内的键引用，显示时自动翻译；去掉后没剩文字 → 不是待提取的文本
        const plain = stripFormatting(s).replace(/%[A-Za-z_][\w:-]*(?:\.[\w:-]+)+/g, ' ').trim();
        if (!plain) return false;
        if (!hasLetters(plain)) return false;
        if (hasCJK(plain)) return !looksLikeCode(plain);
        if (looksLikeCode(plain)) return false;
        if (mode === 'loose') return true;
        // strict：多个单词，或首字母大写的单词
        if (/\s/.test(plain) && /\p{L}{2,}/u.test(plain)) return true;
        if (/^\p{Lu}[\p{L}'’-]{2,}[!?.]?$/u.test(plain)) return true;
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

    function parseJsonLenient(content) {
        const s = stripBOM(content);
        try { return JSON.parse(s); } catch (e) { /* 继续 */ }
        try { return JSON.parse(stripJsonCommentsAndCommas(s)); } catch (e) { /* 继续 */ }
        if (root.JSON5) {
            try { return root.JSON5.parse(s); } catch (e) { /* 放弃 */ }
        }
        return undefined;
    }

    // ---------------------------------------------------------------
    //  正则转义
    // ---------------------------------------------------------------

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    Object.assign(NS, {
        stripFormatting, hasCJK, hasLetters, isEmptyText, isLikelyKey,
        looksLikeCode, looksLikeText,
        hash6, sanitizeKeyPart, sanitizeKey, fileBaseOf, humanizeIdentifier,
        stripBOM, parseLang, toLangValue, fixMixedPlaceholders,
        stripJsonCommentsAndCommas, parseJsonLenient, escapeRegex,
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
