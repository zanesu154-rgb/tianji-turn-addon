/* ================================================================
 *  script.js —— 基于 AST（acorn）的脚本文本提取
 *
 *  两层策略：
 *  1) 静态改写：显示类 API 的参数（form.title/button/…、sendMessage、
 *     setActionBar、setTitle、runCommand…）如果是字面量 / 模板字符串 /
 *     字符串拼接 / 三元表达式，直接改写成 RawMessage（带 with 参数）。
 *  2) 运行时映射：参数是变量、对象属性、函数返回值等无法静态确定的值时，
 *     用注入的小运行时 __i18n.M(x) 包一层。文件中所有“像玩家文本”的字符串
 *     （包括模板/拼接形成的句式）都登记到映射表里，运行时按原文查到键，
 *     再转换成 RawMessage。原数据仍是字符串，比较/拼接逻辑不受影响。
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;
    const { looksLikeText, fileBaseOf, translateCommand, looksLikeCommand } = NS;

    const FORM_CLASSES = new Set(['ActionFormData', 'ModalFormData', 'MessageFormData']);

    // kind: form = server-ui 表单；msg = 消息/标题；cmd = 命令
    const SINKS = {
        title: { kind: 'form', args: [0] },
        body: { kind: 'form', args: [0] },
        button: { kind: 'form', args: [0] },
        button1: { kind: 'form', args: [0] },
        button2: { kind: 'form', args: [0] },
        label: { kind: 'form', args: [0] },
        header: { kind: 'form', args: [0] },
        submitButton: { kind: 'form', args: [0] },
        textField: { kind: 'form', args: [0, 1], optKeys: ['tooltip'] },
        dropdown: { kind: 'form', args: [0], arrays: [1], optKeys: ['tooltip'] },
        slider: { kind: 'form', args: [0], optKeys: ['tooltip'] },
        toggle: { kind: 'form', args: [0], optKeys: ['tooltip'] },
        sendMessage: { kind: 'msg', args: [0] },
        setActionBar: { kind: 'msg', args: [0] },
        setTitle: { kind: 'msg', args: [0], optKeys: ['subtitle'] },
        updateSubtitle: { kind: 'msg', args: [0] },
        runCommand: { kind: 'cmd' },
        runCommandAsync: { kind: 'cmd' },
    };

    // 这些调用的字符串参数是技术标识，不登记到映射表
    const TECH_CALLS = new Set([
        'getDynamicProperty', 'setDynamicProperty', 'hasTag', 'addTag', 'removeTag', 'getObjective',
        'removeObjective', 'getComponent', 'hasComponent', 'spawnEntity', 'spawnItem',
        'spawnParticle', 'playSound', 'playMusic', 'queueMusic', 'triggerEvent', 'getProperty', 'setProperty',
        'resolve', 'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'split', 'replace',
        'replaceAll', 'match', 'matchAll', 'search', 'localeCompare', 'padStart', 'padEnd', 'join', 'get',
        'has', 'delete', 'require', 'getDimension', 'matches', 'getEffect', 'addEffect', 'removeEffect',
        'log', 'warn', 'error', 'info', 'debug', 'trace', 'sendScriptEvent', 'getTypeId', 'setGameRule',
        'getBlockAbove', 'setPermutation', 'withState', 'getState', 'registerCommand', 'registerEnum',
        'Error', 'TypeError', 'RangeError', 'RegExp', 'ItemStack', 'BlockPermutation', 'MolangVariableMap',
        'test', 'exec', 'Symbol', 'parseInt', 'parseFloat', 'Number', 'Date', 'setItem', 'getItem', 'querySelector',
    ]);

    // 这些属性名对应的值是技术数据
    const TECH_PROPS = /^(patterns?|keywords?|triggers?|aliases|synonyms|regex(es)?|regexp|match(es)?|intent|intents|id|typeId|identifier|type|icon|iconPath|texture|image|path|sound|event|tag|tags|objective|permission|defaultValue|key|namespace|entity|item|block|dimension|mode|command|cmd|url|uuid|color|font)$/i;

    // 这些位置的文本玩家能看到但游戏不支持翻译键 —— 记录到报告
    const UNTRANSLATABLE_ASSIGN = new Set(['nameTag']);
    const UNTRANSLATABLE_CALLS = { setLore: '物品描述（setLore）', addObjective: '计分板显示名', setDisplayName: '显示名' };

    // ---------------------------------------------------------------
    //  AST 工具
    // ---------------------------------------------------------------

    function parse(source) {
        const acorn = root.acorn;
        if (!acorn) throw new Error('未加载 acorn 解析器');
        const base = {
            ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true, allowImportExportEverywhere: true,
        };
        try { return acorn.parse(source, { ...base, sourceType: 'module' }); }
        catch (e) { return acorn.parse(source, { ...base, sourceType: 'script' }); }
    }

    function childrenOf(node) {
        const out = [];
        for (const k in node) {
            if (k === 'parent' || k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
            const v = node[k];
            if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); }
            else if (v && typeof v.type === 'string') out.push(v);
        }
        return out;
    }

    /** 深度优先遍历并设置 parent（非枚举属性，避免被 childrenOf 遍历到） */
    function walk(ast, visit) {
        const stack = [ast];
        while (stack.length) {
            const node = stack.pop();
            visit(node);
            const kids = childrenOf(node);
            for (let i = kids.length - 1; i >= 0; i--) {
                Object.defineProperty(kids[i], 'parent', { value: node, enumerable: false, configurable: true, writable: true });
                stack.push(kids[i]);
            }
        }
    }

    function isStr(n) {
        return n && n.type === 'Literal' && typeof n.value === 'string';
    }

    function propName(member) {
        if (!member || member.type !== 'MemberExpression') return null;
        if (!member.computed && member.property.type === 'Identifier') return member.property.name;
        if (member.computed && isStr(member.property)) return member.property.value;
        return null;
    }

    function calleeName(call) {
        const c = call.callee;
        if (c.type === 'Identifier') return c.name;
        return propName(c);
    }

    /**
     * 把模板字符串 / 字符串拼接拆成 [{lit} | {expr}] 片段。
     * 拼接链左侧连续的非字符串操作数（可能是数值加法）作为一个整体表达式。
     */
    function flattenConcat(node) {
        if (node.type === 'TemplateLiteral') {
            const parts = [];
            node.quasis.forEach((q, i) => {
                if (q.value.cooked) parts.push({ lit: q.value.cooked });
                if (i < node.expressions.length) parts.push({ expr: node.expressions[i] });
            });
            return parts;
        }
        if (node.type === 'BinaryExpression' && node.operator === '+') {
            // 收集左脊上的操作数
            const operands = [];
            let cur = node;
            while (cur.type === 'BinaryExpression' && cur.operator === '+' && !cur.extra_paren) {
                operands.unshift(cur.right);
                cur = cur.left;
            }
            operands.unshift(cur);
            const firstStr = operands.findIndex(o => isStr(o) || o.type === 'TemplateLiteral');
            if (firstStr < 0) return null;
            const parts = [];
            if (firstStr > 0) {
                // 前面的整体当作一个表达式：取源码区间 [operands[0].start, operands[firstStr-1].end]
                parts.push({ exprRange: [operands[0], operands[firstStr - 1]], prefixNode: firstStr === 1 ? operands[0] : null });
            }
            for (let i = firstStr; i < operands.length; i++) {
                const o = operands[i];
                if (isStr(o)) parts.push({ lit: o.value });
                else if (o.type === 'TemplateLiteral') parts.push(...flattenConcat(o));
                else parts.push({ expr: o });
            }
            return parts;
        }
        return null;
    }

    function litText(parts) {
        return parts.filter(p => 'lit' in p).map(p => p.lit).join('');
    }

    /** 把片段按换行切成多行（每行仍是片段数组） */
    function splitLines(parts) {
        const lines = [[]];
        for (const p of parts) {
            if ('lit' in p) {
                const segs = p.lit.split(/\r?\n/);
                segs.forEach((s, i) => {
                    if (i > 0) lines.push([]);
                    if (s) lines[lines.length - 1].push({ lit: s });
                });
            } else lines[lines.length - 1].push(p);
        }
        return lines;
    }

    /** 片段 → lang 值（动态部分为 %1$s …） */
    function partsToValue(parts) {
        const hasExpr = parts.some(p => !('lit' in p));
        let n = 0;
        return parts.map(p => ('lit' in p) ? (hasExpr ? p.lit.replace(/%/g, '%%') : p.lit) : `%${++n}$s`).join('');
    }

    function templateEscape(s) {
        return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    }

    // ---------------------------------------------------------------
    //  脚本自带的多语言表
    //   { en: "Hello", zh: "你好" } / { en_US: {...}, zh_CN: {...} } / [{ s: "...", v: "..." }]
    // ---------------------------------------------------------------

    const LOCALE_ALIASES = {
        en: 'en_US', en_us: 'en_US', enus: 'en_US', english: 'en_US', en_gb: 'en_GB',
        zh: 'zh_CN', zh_cn: 'zh_CN', zhcn: 'zh_CN', cn: 'zh_CN', chs: 'zh_CN', chinese: 'zh_CN', zh_hans: 'zh_CN',
        zh_tw: 'zh_TW', zhtw: 'zh_TW', tw: 'zh_TW', cht: 'zh_TW', zh_hant: 'zh_TW',
        vi: 'vi_VN', vn: 'vi_VN', vi_vn: 'vi_VN', ja: 'ja_JP', jp: 'ja_JP', ja_jp: 'ja_JP',
        ko: 'ko_KR', kr: 'ko_KR', ko_kr: 'ko_KR', ru: 'ru_RU', ru_ru: 'ru_RU',
        es: 'es_ES', es_es: 'es_ES', es_mx: 'es_MX', de: 'de_DE', de_de: 'de_DE', fr: 'fr_FR', fr_fr: 'fr_FR', fr_ca: 'fr_CA',
        pt: 'pt_BR', pt_br: 'pt_BR', pt_pt: 'pt_PT', it_it: 'it_IT', th: 'th_TH', th_th: 'th_TH',
        tr: 'tr_TR', tr_tr: 'tr_TR', pl: 'pl_PL', pl_pl: 'pl_PL', uk_ua: 'uk_UA', nl: 'nl_NL', nl_nl: 'nl_NL', id_id: 'id_ID',
    };
    const localeOfKey = (k) => LOCALE_ALIASES[String(k).toLowerCase().replace(/-/g, '_')] ||
        (/^[a-z]{2}_[A-Z]{2}$/.test(String(k)) ? String(k) : null);

    // 常用虚词 + 特征字母，用于区分拉丁字母语言
    const LATIN_LANGS = {
        en_US: { words: 'the is are was were and you your to of with for this that it its in on not what how there have has be can will as by from an or which when than into through more means same also if so do does just', chars: '' },
        es_ES: { words: 'el la los las es son y de que en un una para con por del al cuando está hay muy pero como estoy cuántos', chars: 'ñ¿¡áíóú' },
        fr_FR: { words: 'le la les est sont et de des que en un une pour avec dans du au vous pas je il elle ce suis combien qui ne mon ma où nous', chars: 'çœèêàùâîôë' },
        de_DE: { words: 'der die das ist sind und zu von mit für ein eine nicht den dem ich du wenn auch auf', chars: 'äöüß' },
        pt_BR: { words: 'o a os as é são e de que em um uma para com não do da quando você mas isso seu sua pelo pela nos nas ao muito também está', chars: 'ãõ' },
        it_IT: { words: 'il lo la gli le è sono e di che in un una per con non del della quando anche', chars: 'ìò' },
        id_ID: { words: 'yang dan di ke dari ini itu dengan untuk tidak adalah ada kamu saya akan', chars: '' },
        nl_NL: { words: 'de het een is zijn en van dat met voor niet op je als ook', chars: 'ĳ' },
        tr_TR: { words: 've bir bu için ile değil çok ne da de gibi', chars: 'ğşıİ' },
        pl_PL: { words: 'i w nie na się jest że do z to jak ale', chars: 'ąęłńśźż' },
    };
    for (const v of Object.values(LATIN_LANGS)) v.set = new Set(v.words.split(' '));

    /** 粗略判断文本语言；没把握返回 null */
    function guessLang(text, minScore = 2) {
        const t = String(text).replace(/§./g, '');
        if (/[぀-ヿ]/.test(t)) return 'ja_JP';
        if (/[가-힯]/.test(t)) return 'ko_KR';
        if (/[一-鿿]/.test(t)) return 'zh_CN';
        if (/[Ѐ-ӿ]/.test(t)) return 'ru_RU';
        if (/[฀-๿]/.test(t)) return 'th_TH';
        if (/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(t)) return 'vi_VN';
        const words = t.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
        if (!words.length) return null;
        const lower = t.toLowerCase();
        const scores = Object.entries(LATIN_LANGS).map(([lang, d]) => {
            let sc = words.filter(w => d.set.has(w)).length;
            for (const c of d.chars) if (lower.includes(c)) sc += 2;
            return [lang, sc];
        }).sort((x, y) => y[1] - x[1]);
        const [best, second] = scores;
        if (best[1] >= minScore && best[1] > second[1]) return best[0];
        return null;
    }

    /** 从文件名里找语言提示：dialogue_es.js / lang-vi.js / spanish.js */
    function langHintFromFile(file) {
        const base = String(file).split('/').pop().replace(/\.[^.]+$/, '');
        const NAMES = { spanish: 'es_ES', espanol: 'es_ES', vietnamese: 'vi_VN', french: 'fr_FR', german: 'de_DE',
            portuguese: 'pt_BR', italian: 'it_IT', russian: 'ru_RU', japanese: 'ja_JP', korean: 'ko_KR', chinese: 'zh_CN', english: 'en_US' };
        const m = /(?:^|[_\-.])([a-z]{2}(?:[_\-][a-z]{2})?)$/i.exec(base);
        if (m) { const l = localeOfKey(m[1]); if (l) return l; }
        for (const tok of base.toLowerCase().split(/[_\-.]+/)) if (NAMES[tok]) return NAMES[tok];
        return null;
    }

    /**
     * 把简单的句式正则还原成句子：/^(.+) is my only one\.$/ → { parts: [{g:1}, {lit:" is my only one."}] }
     * 只接受：普通文字、转义的标点、不嵌套的捕获组；其它语法（可选、分支、字符类…）返回 null
     */
    function regexToSentence(pattern) {
        let p = pattern;
        if (p.startsWith('^')) p = p.slice(1);
        if (p.endsWith('$') && !p.endsWith('\\$')) p = p.slice(0, -1);
        const parts = [];
        let lit = '', group = 0;
        for (let i = 0; i < p.length; i++) {
            const c = p[i];
            if (c === '\\') {
                const nx = p[i + 1];
                if (nx === 'n') lit += '\n';
                else if (/[.?*+()[\]{}|^$\\/\-]/.test(nx)) lit += nx;
                else return null;           // \d \s \b … 出现在组外
                i++;
                continue;
            }
            if (c === '(') {
                if (p[i + 1] === '?') return null;
                let depth = 1, j = i + 1;
                for (; j < p.length && depth; j++) {
                    if (p[j] === '\\') { j++; continue; }
                    if (p[j] === '(') return null;
                    if (p[j] === ')') depth--;
                }
                if (depth) return null;
                if (p[j] === '?' || p[j] === '*' || p[j] === '+') return null;   // 可选组
                if (lit) { parts.push({ lit }); lit = ''; }
                parts.push({ g: ++group });
                i = j - 1;
                continue;
            }
            if (/[.?*+[\]{}|^$]/.test(c)) return null;
            lit += c;
        }
        if (lit) parts.push({ lit });
        if (!parts.some(x => x.lit && /\p{L}{2,}/u.test(x.lit))) return null;
        return { parts, groups: group, text: parts.filter(x => x.lit).map(x => x.lit).join(' ') };
    }

    /** 模板 `${a} de ${b} corazones.` 配合参数 (_, a, b) 或 (m) → m[1] 还原成 { parts: [{g:1}, {lit:" de "}, {g:2}, …] } */
    function templateToSentence(node, params) {
        const paramIdx = new Map();
        params.forEach((pa, i) => { if (pa.type === 'Identifier') paramIdx.set(pa.name, i); });
        const matchVar = params.length === 1 && params[0].type === 'Identifier' ? params[0].name : null;
        const groupOf = (expr) => {
            // 允许 name(d)、translateOutput(c) 这类单参数包装
            let e = expr;
            while (e.type === 'CallExpression' && e.arguments.length === 1) e = e.arguments[0];
            if (e.type === 'Identifier' && paramIdx.has(e.name) && paramIdx.get(e.name) > 0) return paramIdx.get(e.name);
            if (matchVar && e.type === 'MemberExpression' && e.computed && e.object.type === 'Identifier' &&
                e.object.name === matchVar && e.property.type === 'Literal' && Number.isInteger(e.property.value) && e.property.value > 0) return e.property.value;
            return null;
        };
        if (isStr(node)) return { parts: [{ lit: node.value }], text: node.value };
        const parts = [];
        for (let i = 0; i < node.quasis.length; i++) {
            const q = node.quasis[i].value.cooked;
            if (q) parts.push({ lit: q });
            if (i < node.expressions.length) {
                const g = groupOf(node.expressions[i]);
                if (!g) return null;
                parts.push({ g });
            }
        }
        return { parts, text: parts.filter(x => x.lit).map(x => x.lit).join(' ') };
    }

    function propKey(p) {
        if (!p || p.type !== 'Property' || p.computed) return null;
        return p.key.type === 'Identifier' ? p.key.name : (typeof p.key.value === 'string' ? p.key.value : null);
    }

    /**
     * 找出脚本里的多语言表。
     * @param fieldMode { mode: 'auto'|'off'|'manual', map: Map(字段名 → 语言) }
     * @returns { groups: [Map(语言 → 字符串节点)], notes: [string] }
     */
    function collectTranslationGroups(ast, fieldMode) {
        const groups = [];
        const notes = [];
        const sentenceRules = [];
        const used = new Set();
        const userMap = (fieldMode && fieldMode.map) || new Map();
        if (fieldMode && fieldMode.mode === 'off') return { groups, notes, sentenceRules };

        // 变量名 → 赋给它的对象字面量（const a = {...} / a = {...}），用于解析 { en_US: a } 或 register("en_US", a, b)
        const objBind = new Map();
        walk(ast, (n) => {
            if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && n.init.type === 'ObjectExpression') objBind.set(n.id.name, n.init);
            else if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier' && n.right.type === 'ObjectExpression') objBind.set(n.left.name, n.right);
        });
        const resolveObj = (nd) => nd && (nd.type === 'ObjectExpression' ? nd : nd.type === 'Identifier' ? objBind.get(nd.name) : null);

        // pairs: [[语言, 对象/数组节点]…]；同一路径下不同语言的字符串组成一组
        const emitPairs = (pairs) => {
            const byPath = new Map();
            const collect = (node, lang, path) => {
                if (!node) return;
                if (node.type === 'Identifier' && path === '') node = resolveObj(node);
                if (!node) return;
                if (isStr(node) || (node.type === 'TemplateLiteral' && !node.expressions.length)) {
                    if (!byPath.has(path)) byPath.set(path, new Map());
                    const nd = isStr(node) ? node : Object.assign(node, { value: node.quasis[0].value.cooked });
                    byPath.get(path).set(lang, nd);
                } else if (node.type === 'ObjectExpression') {
                    used.add(node);
                    for (const p of node.properties) { const k = propKey(p); if (k != null) collect(p.value, lang, `${path}.${k}`); }
                } else if (node.type === 'ArrayExpression') {
                    node.elements.forEach((e, i) => collect(e, lang, `${path}[${i}]`));
                }
            };
            for (const [lang, nd] of pairs) collect(nd, lang, '');
            let n = 0;
            for (const m of byPath.values()) {
                const vals = [...m.values()].map(nd => nd.value);
                if (m.size >= 2 && new Set(vals).size > 1 && vals.some(v => looksLikeText(v, 'loose'))) { m.fromDict = true; groups.push(m); n++; }
                // 只有某种非英语字典里才有的条目（作者没写英文）→ 也归到该语言
                else if (m.size === 1 && !m.has('en_US') && looksLikeText(vals[0], 'loose')) { m.fromDict = true; groups.push(m); n++; }
            }
            return n;
        };

        const emit = (objNode, langOf) => {
            const byPath = new Map();
            const collect = (node, lang, path) => {
                if (!node) return;
                if (isStr(node)) {
                    if (!byPath.has(path)) byPath.set(path, new Map());
                    byPath.get(path).set(lang, node);
                } else if (node.type === 'ObjectExpression') {
                    used.add(node);
                    for (const p of node.properties) { const k = propKey(p); if (k != null) collect(p.value, lang, `${path}.${k}`); }
                } else if (node.type === 'ArrayExpression') {
                    node.elements.forEach((e, i) => collect(e, lang, `${path}[${i}]`));
                }
            };
            for (const p of objNode.properties) {
                const k = propKey(p);
                const lang = k != null && langOf(k);
                if (lang) collect(p.value, lang, '');
            }
            used.add(objNode);
            let n = 0;
            for (const m of byPath.values()) {
                const vals = [...m.values()].map(nd => nd.value);
                // 各语言的值完全相同 → 不是译文（如每种语言下都有同一句英文原文）
                if (m.size >= 2 && new Set(vals).size > 1 && vals.some(v => looksLikeText(v, 'loose'))) { groups.push(m); n++; }
            }
            return n;
        };

        // (a) 键名是语言代码 / 用户指定的字段
        const langOfKey = (k) => userMap.get(k) || localeOfKey(k);
        walk(ast, (n) => {
            if (n.type !== 'ObjectExpression' || used.has(n)) return;
            const langProps = n.properties.filter(p => { const k = propKey(p); return k != null && langOfKey(k); });
            if (langProps.length < 2) return;
            // { es: [{ s, v }], vi: [{ s, v }] } —— 每种语言下是“对象数组”，交给下面按数组识别平行字段
            if (!userMap.size && langProps.some(p => p.value.type === 'ArrayExpression' &&
                p.value.elements.some(e => e && e.type === 'ObjectExpression'))) return;
            emit(n, langOfKey);
        });

        // (a2) 按语言分开的字典，用带语言代码的调用登记：
        //      register("en_US", dictA, dictB); register("ja_JP", dictC, dictD)   （打包后的脚本常见，如 Bedrock Reimagined）
        //      { en_US: dictA, ja_JP: dictC }（值是变量名）
        {
            const pairs = [];
            walk(ast, (n) => {
                if (n.type === 'CallExpression' && n.arguments.length >= 2 && isStr(n.arguments[0])) {
                    const lang = localeOfKey(n.arguments[0].value);
                    if (!lang) return;
                    for (const a of n.arguments.slice(1)) { const o = resolveObj(a); if (o && !used.has(o)) pairs.push([lang, o]); }
                } else if (n.type === 'ObjectExpression' && !used.has(n)) {
                    const lp = n.properties.filter(p => { const k = propKey(p); return k != null && localeOfKey(k) && p.value && p.value.type === 'Identifier' && resolveObj(p.value); });
                    if (lp.length >= 2) { used.add(n); lp.forEach(p => pairs.push([localeOfKey(propKey(p)), resolveObj(p.value)])); }
                }
            });
            if (new Set(pairs.map(p => p[0])).size >= 2) {
                const n = emitPairs(pairs);
                if (n) notes.push(`识别到按语言登记的翻译字典（${[...new Set(pairs.map(p => p[0]))].join(', ')}），合并 ${n} 组`);
            }
        }

        // (b) 自动识别“语言不同的平行字段”
        //     对象数组 [{ s: "英文", v: "西语" }, ...]
        //     成对数组 [["英文", "西语"], ...]（常见于 new Map([...])）
        //     名称字典 { "end portal": "портал энда", ... }
        const INPUT_NAME = /input|alias|synonym|keyword|pattern|trigger|fold|normali[sz]e|intent/i;
        const ownerName = (node) => {
            let c = node;
            for (let i = 0; i < 4 && c; i++) {
                c = c.parent;
                if (!c) break;
                if (c.type === 'VariableDeclarator' && c.id && c.id.type === 'Identifier') return c.id.name;
                if (c.type === 'AssignmentExpression') return c.left.type === 'Identifier' ? c.left.name : (propName(c.left) || '');
                if (c.type === 'Property') return propKey(c) || '';
            }
            return '';
        };
        const analyze = (rows, kindLabel, label, allowLongNames) => {
            const cols = new Map();   // 字段 → [文本]
            for (const r of rows) for (const [k, nd] of r) {
                if (looksLikeText(nd.value, 'loose')) {
                    if (!cols.has(k)) cols.set(k, []);
                    cols.get(k).push(nd.value);
                }
            }
            const colLang = new Map();
            for (const [k, texts] of cols) {
                // 只有一行时要求句子足够长，避免两个短词碰巧像不同语言
                if (texts.length < 2 && texts[0].split(/\s+/).length < 5) continue;
                // 逐句判断后投票（个别句子里的人名、外来词不会带偏整列）
                const cnt = new Map();
                texts.forEach(t => { const g = guessLang(t); if (g) cnt.set(g, (cnt.get(g) || 0) + 1); });
                const decided = [...cnt.values()].reduce((x, y) => x + y, 0);
                const best = [...cnt.entries()].sort((x, y) => y[1] - x[1])[0];
                let lang = null;
                if (best && decided >= 3 && best[1] / decided >= 0.7 && best[1] / texts.length >= 0.3) lang = best[0];
                else if (decided < 3) {
                    const joint = guessLang(texts.join(' '), 3);
                    if (joint && [...cnt.keys()].every(l => l === joint)) lang = joint;
                }
                colLang.set(k, lang);
            }
            // 只有一个字段判断不出语言：
            //  - 文件名有提示（dialogue_es.js）→ 用提示
            //  - 另一列已确定是非英语，而这一列全是 ASCII 短句（"Ouch!"、"I'm here."）→ 视为英文原文
            const unknown = [...colLang].filter(([, l]) => !l).map(([k]) => k);
            const known = [...colLang.values()].filter(Boolean);
            const hint = fieldMode && fieldMode.fileHint;
            if (unknown.length === 1 && known.length === 1) {
                const texts = cols.get(unknown[0]);
                if (hint && !known.includes(hint)) colLang.set(unknown[0], hint);
                else if (known[0] !== 'en_US' && texts.every(t => /^[\x20-\x7e—–’…]*$/.test(t))) colLang.set(unknown[0], 'en_US');
            }
            for (const [k, l] of [...colLang]) if (!l) colLang.delete(k);
            // 同一种语言出现在多个字段（如 name 和 desc 都是中文）→ 不是平行翻译
            const langCount = new Map();
            for (const l of colLang.values()) langCount.set(l, (langCount.get(l) || 0) + 1);
            for (const [k, l] of [...colLang]) if (langCount.get(l) > 1) colLang.delete(k);
            if (colLang.size < 2) return false;
            const desc = [...colLang].map(([k, l]) => `${label(k)}→${l}`).join(', ');
            if (allowLongNames || [...colLang.keys()].every(k => k.length <= 3)) {
                let total = 0;
                for (const r of rows) {
                    const g = new Map();
                    for (const [k, l] of colLang) if (r.has(k)) g.set(l, r.get(k));
                    const vals = [...g.values()].map(nd => nd.value);
                    if (g.size >= 2 && new Set(vals).size > 1 && vals.some(v => looksLikeText(v, 'loose'))) { groups.push(g); total++; }
                }
                notes.push(`自动识别脚本内置多语言${kindLabel} ${desc}，合并 ${total} 条（如识别有误，可在选项中关闭或手动指定）`);
                return true;
            }
            notes.push(`字段 ${desc} 可能是脚本内置的多语言版本，未自动合并；如确认，请在选项“脚本自带翻译字段”中填写 ${[...colLang].map(([k, l]) => `${k}=${l}`).join(', ')}`);
            return false;
        };

        if (!fieldMode || fieldMode.mode === 'auto') {
            walk(ast, (n) => {
                if (n.type === 'ArrayExpression') {
                    if (INPUT_NAME.test(ownerName(n))) return;   // 玩家输入归一化表（外语 → 英文），不是译文
                    const rows = [];
                    let pairRows = 0;
                    for (const e of n.elements) {
                        if (!e || used.has(e)) continue;
                        if (e.type === 'ObjectExpression') {
                            const r = new Map();
                            for (const p of e.properties) { const k = propKey(p); if (k != null && isStr(p.value)) r.set(k, p.value); }
                            rows.push(r);
                        } else if (e.type === 'ArrayExpression' && e.elements.length >= 2 && e.elements.length <= 4 && e.elements.every(isStr)) {
                            rows.push(new Map(e.elements.map((x, i) => [String(i), x])));
                            pairRows++;
                        }
                    }
                    if (!rows.length) return;
                    if (analyze(rows, pairRows ? '（成对数组）' : '字段', k => pairRows ? `第${+k + 1}项` : k, false)) {
                        n.elements.forEach(e => e && used.add(e));
                    }
                    return;
                }
                // 名称字典 { "end portal": "портал энда" } —— 键是原文、值是译文
                if (n.type === 'ObjectExpression' && !used.has(n) && n.properties.length >= 3) {
                    if (INPUT_NAME.test(ownerName(n))) return;   // 玩家输入归一化，不是译文
                    if (!n.properties.every(p => p.type === 'Property' && !p.computed && isStr(p.value) && propKey(p) != null)) return;
                    const rows = n.properties.map(p => new Map([['0', { value: propKey(p), pseudo: true }], ['1', p.value]]));
                    if (analyze(rows, '（名称字典）', k => (k === '0' ? '键' : '值'), true)) used.add(n);
                }
            });
        }

        // (b2) 逐条 .set("英文", "译文")：CURATED_OUTPUT.set(...); 按对象名分组
        if (!fieldMode || fieldMode.mode === 'auto') {
            const byObj = new Map();
            walk(ast, (n) => {
                if (n.type !== 'CallExpression' || n.arguments.length !== 2 || !n.arguments.every(isStr)) return;
                if (n.callee.type !== 'MemberExpression' || propName(n.callee) !== 'set' || n.callee.object.type !== 'Identifier') return;
                const obj = n.callee.object.name;
                if (INPUT_NAME.test(obj)) return;
                if (!byObj.has(obj)) byObj.set(obj, []);
                byObj.get(obj).push(new Map([['0', n.arguments[0]], ['1', n.arguments[1]]]));
            });
            for (const [obj, rows] of byObj) {
                if (rows.length >= 2) analyze(rows, `（${obj}.set）`, k => (k === '0' ? '参数1' : '参数2'), true);
            }
        }

        // (c) 句式规则 [/^Good morning, (.+)\.$/, (m) => `Chào buổi sáng, ${m[1]}.`]
        //     正则还原成英文句式，模板还原成译文句式，按捕获组对齐参数
        if (!fieldMode || fieldMode.mode !== 'off') {
            walk(ast, (n) => {
                if (n.type !== 'ArrayExpression') return;
                if (INPUT_NAME.test(ownerName(n))) return;
                const rules = [];
                for (const e of n.elements) {
                    if (!e || e.type !== 'ArrayExpression' || e.elements.length !== 2) continue;
                    const [re, fn] = e.elements;
                    if (!re || re.type !== 'Literal' || !re.regex) continue;
                    if (!fn || !/FunctionExpression$/.test(fn.type)) continue;
                    const src = regexToSentence(re.regex.pattern);
                    if (!src) continue;
                    let body = fn.body;
                    if (body.type === 'BlockStatement') {
                        const ret = body.body.length === 1 && body.body[0].type === 'ReturnStatement' ? body.body[0].argument : null;
                        body = ret;
                    }
                    if (!body || (body.type !== 'TemplateLiteral' && !isStr(body))) continue;
                    const tr = templateToSentence(body, fn.params);
                    if (!tr) continue;
                    rules.push({ src, tr, node: body });
                }
                if (rules.length < 2) return;
                const cnt = new Map();
                rules.forEach(r => { const g = guessLang(r.tr.text); if (g && g !== 'en_US') cnt.set(g, (cnt.get(g) || 0) + 1); });
                let lang = [...cnt.entries()].sort((x, y) => y[1] - x[1])[0];
                lang = lang && lang[1] >= Math.max(2, rules.length * 0.4) ? lang[0] : (fieldMode && fieldMode.fileHint) || null;
                if (!lang || lang === 'en_US') return;
                for (const r of rules) sentenceRules.push({ ...r, lang });
                notes.push(`自动识别句式规则（正则 → 模板）${rules.length} 条：英文 → ${lang}`);
            });
        }
        return { groups, notes, sentenceRules };

    }

    // ---------------------------------------------------------------
    //  玩家输入匹配表（聊天关键词 / 正则）—— 只导出，不修改
    // ---------------------------------------------------------------

    /** 把 /\b(?:a|b c|d)\b/ 拆成 ["a", "b c", "d"]；拆不开返回 [原样] */
    function regexPhrases(pattern) {
        let p = pattern.replace(/^\^|\$$/g, '').replace(/^(\\b)+|(\\b)+$/g, '');
        const unwrap = /^\((?:\?:)?([\s\S]*)\)$/.exec(p);
        if (unwrap) {
            // 确认首尾括号是一对
            let depth = 0, ok = true;
            for (let i = 0; i < p.length; i++) {
                if (p[i] === '\\') { i++; continue; }
                if (p[i] === '(') depth++;
                else if (p[i] === ')') { depth--; if (depth === 0 && i < p.length - 1) { ok = false; break; } }
            }
            if (ok) p = unwrap[1];
        }
        const alts = [];
        let cur = '', depth = 0;
        for (let i = 0; i < p.length; i++) {
            const c = p[i];
            if (c === '\\') { cur += c + (p[i + 1] || ''); i++; continue; }
            if (c === '(' || c === '[') depth++;
            if (c === ')' || c === ']') depth--;
            if (c === '|' && depth === 0) { alts.push(cur); cur = ''; continue; }
            cur += c;
        }
        alts.push(cur);
        return alts.map(a => a.replace(/\\b/g, '').replace(/\\s[+*]?/g, ' ').replace(/\\(.)/g, '$1').trim()).filter(Boolean);
    }

    function langsOf(texts) {
        const set = new Set();
        for (const t of texts) { const g = guessLang(t, 1); if (g) set.add(g); }
        // 短语太短判断不出时，整体再判断一次
        if (!set.size) { const g = guessLang(texts.join(' ')); if (g) set.add(g); }
        return [...set];
    }

    function collectInputTables(ast, file) {
        const rows = [];
        walk(ast, (n) => {
            // [/正则/, "内部标记"]
            if (n.type === 'ArrayExpression' && n.elements.length === 2) {
                const [a, b] = n.elements;
                if (a && a.type === 'Literal' && a.regex && isStr(b)) {
                    const phrases = regexPhrases(a.regex.pattern);
                    rows.push({ file, kind: '归一化', target: b.value, answer: '', phrases, keywords: [],
                        langs: langsOf([...phrases, b.value]), regex: `/${a.regex.pattern}/${a.regex.flags}` });
                }
            }
            // { patterns: [/…/], keywords: [...], answers: [...] }
            if (n.type === 'ObjectExpression') {
                const get = (name) => n.properties.find(p => /^(patterns?|regex(es)?|triggers?)$/i.test(propKey(p) || '') && name === 'p' ||
                    /^(keywords?|synonyms|aliases)$/i.test(propKey(p) || '') && name === 'k' ||
                    /^(answers?|responses?|replies|reply|text|message)$/i.test(propKey(p) || '') && name === 'a');
                const pp = get('p'), kp = get('k'), ap = get('a');
                if (!pp && !kp) return;
                const arr = (prop) => !prop ? [] : prop.value.type === 'ArrayExpression' ? prop.value.elements.filter(Boolean) : [prop.value];
                const regs = arr(pp).filter(e => e.type === 'Literal' && e.regex);
                const kws = arr(kp).filter(isStr).map(e => e.value);
                if (!regs.length && !kws.length) return;
                const answers = arr(ap).filter(isStr).map(e => e.value);
                const phrases = regs.flatMap(r => regexPhrases(r.regex.pattern));
                rows.push({ file, kind: '触发', target: '', answer: answers[0] || '', phrases, keywords: kws,
                    langs: langsOf([...phrases, ...kws]), regex: regs.map(r => `/${r.regex.pattern}/${r.regex.flags}`).join(' ') });
            }
        });
        return rows;
    }

    // ---------------------------------------------------------------
    //  预扫描：用于跨文件判断
    // ---------------------------------------------------------------

    function collectScriptInfo(source) {
        const info = { usesServerUi: /@minecraft\/server-ui/.test(source), methods: new Set(), ok: true, ast: null };
        let ast;
        try { ast = parse(source); } catch (e) { info.ok = false; info.error = e.message; return info; }
        info.ast = ast;
        walk(ast, (n) => {
            if (n.type === 'MethodDefinition' && n.key && n.key.type === 'Identifier') info.methods.add(n.key.name);
            if (n.type === 'Property' && n.key && n.key.type === 'Identifier' &&
                (n.method || (n.value && /Function/.test(n.value.type)))) info.methods.add(n.key.name);
        });
        return info;
    }

    // ---------------------------------------------------------------
    //  运行时（注入到脚本顶部）
    // ---------------------------------------------------------------

    function buildRuntime(rtName, globalKey) {
        return `const ${rtName} = (() => {
  const g = globalThis, K = ${JSON.stringify(globalKey)};
  if (g[K]) return g[K];
  const m = new Map(), p = [], cache = new Map();
  const esc = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const T = (v) => {
    if (v !== null && typeof v === "object") return v;
    const s = String(v);
    return lookup(s) || { text: s };
  };
  // 多行文本按“每行去掉首尾空白”再比一次（代码常先 trim 每行再显示）
  const N = (s) => s.split("\\n").map((l) => l.trim()).join("\\n");
  const one = (s) => {
    let k = m.get(s);
    if (k) return [{ translate: k }];
    if (s.indexOf("\\n") >= 0 && (k = m.get(N(s)))) return [{ translate: k }];
    const mm = /^((?:\\u00a7.|\\s)*)([\\s\\S]*?)((?:\\u00a7.|\\s)*)$/.exec(s);
    if (mm && mm[2] !== s && (k = m.get(mm[2]))) {
      const r = [{ translate: k }];
      if (mm[1]) r.unshift({ text: mm[1] });
      if (mm[3]) r.push({ text: mm[3] });
      return r;
    }
    for (const [pk, re, , ord] of p) {
      const x = re.exec(s);
      if (!x) continue;
      let caps = x.slice(1);
      if (ord && ord.length) { const a = []; ord.forEach((g, i) => { if (a[g - 1] === undefined) a[g - 1] = caps[i]; }); for (let i = 0; i < a.length; i++) if (a[i] === undefined) a[i] = ""; caps = a; }
      return [{ translate: pk, with: { rawtext: caps.map(T) } }];
    }
    return null;
  };
  const lookup = (s) => {
    if (cache.has(s)) return cache.get(s);
    let r = one(s);
    if (!r && s.indexOf("\\n") >= 0) {
      const els = []; let hit = false;
      s.split("\\n").forEach((l, i) => {
        if (i) els.push({ text: "\\n" });
        if (!l) return;
        const x = one(l);
        if (x) { hit = true; els.push(...x); } else els.push({ text: l });
      });
      if (hit) r = els;
    }
    r = r ? { rawtext: r } : null;
    if (cache.size > 2000) cache.clear();
    cache.set(s, r);
    return r;
  };
  const M = (v) => (typeof v === "string" ? lookup(v) || v : v);
  const MA = (a) => (Array.isArray(a) ? a.map(M) : a);
  const J = (v) => JSON.stringify(String(v)).slice(1, -1);
  const TJ = (v) => JSON.stringify(T(v));
  const C = (cmd) => {
    if (typeof cmd !== "string") return cmd;
    const t = /^([\\s\\S]*?(?:^|[\\s\\/]))title(\\s+(?:@[a-z]+(?:\\[[^\\]]*\\])?|"[^"]*"|\\S+)\\s+(?:title|subtitle|actionbar)\\s+)([\\s\\S]+)$/.exec(cmd);
    if (t && (t[1] === "" || /(?:^\\/?|\\srun\\s)$/.test(t[1]))) {
      const r = lookup(t[3].trim());
      return r ? t[1] + "titleraw" + t[2] + JSON.stringify(r) : cmd;
    }
    if (/\\b(?:tellraw|titleraw)\\b/.test(cmd)) {
      return cmd.replace(/"text"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"/g, (all, raw) => {
        let s; try { s = JSON.parse('"' + raw + '"'); } catch (e) { return all; }
        const k = m.get(s);
        return k ? '"translate":' + JSON.stringify(k) : all;
      });
    }
    return cmd;
  };
  const reg = (exact, pats) => {
    for (const [s, k] of exact) {
      if (!m.has(s)) m.set(s, k);
      if (s.indexOf("\\n") >= 0 && !m.has(N(s))) m.set(N(s), k);
    }
    for (const [k, lits, ord] of pats) {
      const len = lits.join("").length;
      p.push([k, new RegExp("^" + lits.map(esc).join("([\\\\s\\\\S]*?)") + "$"), len, ord]);
    }
    p.sort((a, b) => b[2] - a[2]);
    cache.clear();
  };
  return (g[K] = { T, M, MA, J, TJ, C, reg });
})();
`;
    }

    // ---------------------------------------------------------------
    //  主处理
    // ---------------------------------------------------------------

    /**
     * @param {string} source
     * @param {string} file
     * @param {ExtractContext} ctx
     * @param {object} opts { info, formSinksEnabled, collidingMethods:Set, runtimeKey, injectRuntime }
     */
    /**
     * 跨文件预扫描：函数参数被拼进显示文本（模板字符串）时，
     * 它的默认值和各处调用传入的字符串字面量也是玩家可见的文字，
     * 如 cancelEvent(source, player, e, sourceName = 'item') 里的 'item' / 'block'。
     * 返回 Map(定义所在文件 → [文字…])，在该文件里登记到运行时映射。
     */
    function collectParamTexts(infos) {
        const defs = new Map();   // 函数名 → [{ file, index }]
        const out = new Map();
        const add = (file, s) => {
            if (typeof s !== 'string' || !/^[A-Za-z][A-Za-z '-]{1,40}$/.test(s) || looksLikeCommand(s)) return;
            if (!out.has(file)) out.set(file, new Set());
            out.get(file).add(s);
        };
        const textTemplateUses = (body, name) => {
            let hit = false;
            walk(body, (n) => {
                if (hit || n.type !== 'TemplateLiteral') return;
                if (!n.expressions.some(e => e.type === 'Identifier' && e.name === name)) return;
                const lit = n.quasis.map(q => q.value.cooked || '').join(' ');
                if (looksLikeText(lit, 'loose') && !looksLikeCommand(n.quasis.map(q => q.value.cooked || '').join('0'))) hit = true;
            });
            return hit;
        };
        for (const [file, info] of infos) {
            if (!info || !info.ok) continue;
            walk(info.ast, (n) => {
                let name = null, fn = null;
                if (n.type === 'FunctionDeclaration' && n.id) { name = n.id.name; fn = n; }
                else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && /Function/.test(n.init.type)) { name = n.id.name; fn = n.init; }
                if (!fn || !fn.params) return;
                fn.params.forEach((pa, index) => {
                    const id = pa.type === 'AssignmentPattern' ? pa.left : pa;
                    if (id.type !== 'Identifier' || !textTemplateUses(fn.body, id.name)) return;
                    if (pa.type === 'AssignmentPattern' && isStr(pa.right)) add(file, pa.right.value);
                    if (!defs.has(name)) defs.set(name, []);
                    defs.get(name).push({ file, index });
                });
            });
        }
        if (defs.size) for (const info of infos.values()) {
            if (!info || !info.ok) continue;
            walk(info.ast, (n) => {
                if (n.type !== 'CallExpression') return;
                const nm = n.callee.type === 'Identifier' ? n.callee.name : propName(n.callee);
                for (const d of defs.get(nm) || []) if (isStr(n.arguments[d.index])) add(d.file, n.arguments[d.index].value);
            });
        }
        return new Map([...out].map(([f, set]) => [f, [...set]]));
    }

    function processScript(source, file, ctx, opts = {}) {
        const info = opts.info || collectScriptInfo(source);
        if (!info.ok) {
            ctx.warn(`${file}: 脚本解析失败（${info.error}），已跳过`);
            return { content: source, changed: false };
        }
        const ast = info.ast;
        const fb = fileBaseOf(file);
        const injectRuntime = opts.injectRuntime !== false;
        const colliding = opts.collidingMethods || new Set();
        const formEnabled = opts.formSinksEnabled !== false;

        // 选一个文件中没出现过的运行时变量名
        let RT = '__i18n';
        while (source.includes(RT)) RT += '_';

        // ---- 收集表单变量 / 表单类别名 ----
        const formClassNames = new Set(FORM_CLASSES);
        const formVars = new Set();
        walk(ast, (n) => {
            if (n.type === 'ImportSpecifier' && n.imported && FORM_CLASSES.has(n.imported.name || n.imported.value)) {
                formClassNames.add(n.local.name);
            }
        });
        const isFormNew = (n) => n && n.type === 'NewExpression' &&
            ((n.callee.type === 'Identifier' && formClassNames.has(n.callee.name)) ||
             (n.callee.type === 'MemberExpression' && FORM_CLASSES.has(propName(n.callee))));
        const formThisProps = new Set();   // this.form = new ActionFormData()
        walk(ast, (n) => {
            if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFormNew(n.init)) formVars.add(n.id.name);
            if (n.type === 'AssignmentExpression' && isFormNew(n.right)) {
                if (n.left.type === 'Identifier') formVars.add(n.left.name);
                else if (n.left.type === 'MemberExpression' && n.left.object.type === 'ThisExpression' && propName(n.left)) formThisProps.add(propName(n.left));
            }
        });
        const rootIsForm = (expr) => {
            let e = expr;
            for (let g = 0; g < 200 && e; g++) {
                if (e.type === 'MemberExpression' && e.object.type === 'ThisExpression' && formThisProps.has(propName(e))) return true;
                if (e.type === 'CallExpression') e = e.callee;
                else if (e.type === 'MemberExpression') e = e.object;
                else if (e.type === 'ParenthesizedExpression') e = e.expression;
                else break;
            }
            return isFormNew(e) || (e && e.type === 'Identifier' && formVars.has(e.name));
        };

        // ---- 改写表 ----
        const overrides = new Map();   // node → () => string
        const handled = new Set();     // 已作为显示参数处理过的节点（不再登记为候选）
        const exact = [];              // [原文, 键]
        const patterns = [];           // [键, [字面量片段…]]
        let usesRuntime = false;
        const warnedCollide = new Set();
        const src = source;

        const renderOrig = (node) => {
            const out = [];
            let pos = node.start;
            const collect = (n) => {
                for (const c of childrenOf(n)) {
                    if (overrides.has(c)) {
                        out.push(src.slice(pos, c.start), overrides.get(c)());
                        pos = c.end;
                    } else if (c.end > pos) collect(c);
                }
            };
            collect(node);
            out.push(src.slice(pos, node.end));
            return out.join('');
        };
        const render = (node) => overrides.has(node) ? overrides.get(node)() : renderOrig(node);
        const renderPart = (p) => {
            if (p.expr) return render(p.expr);
            if (p.prefixNode) return render(p.prefixNode);
            // 拼接链左侧多个非字符串操作数（如 a + b + "文字"）：保持原样整体求值
            const [a, b] = p.exprRange;
            return `(${src.slice(a.start, b.end)})`;
        };
        const markHandled = (node) => walk(node, (n) => handled.add(n));

        const meta = (hint) => ({ file, kind: 'script', scope: 'script', hint });
        const keyBase = (hint) => `script.${fb}.${hint}`;

        /** 片段 → rawtext 元素代码数组；返回 null 表示没有可翻译文本且无动态部分 */
        function buildElements(parts, hint) {
            const lines = ctx.splitNewlines ? splitLines(parts) : [parts];
            const els = [];
            let translated = false;
            lines.forEach((line, li) => {
                if (li > 0) els.push(JSON.stringify({ text: '\n' }));
                if (!line.length) return;
                const lit = litText(line);
                if (looksLikeText(lit, 'loose') && !(line.length === 1 && ctx.isKey(lit))) {
                    // 剥离首尾格式码
                    const first = line[0], last = line[line.length - 1];
                    let lead = '', tail = '';
                    const body = line.map(p => ({ ...p }));
                    if ('lit' in first) {
                        const m = /^(?:§.|\s)*/.exec(first.lit)[0];
                        lead = m; body[0].lit = first.lit.slice(m.length);
                    }
                    const lb = body[body.length - 1];
                    if ('lit' in lb) {
                        const m = /(?:§.|\s)*$/.exec(lb.lit)[0];
                        if (m && m.length < lb.lit.length) { tail = m; lb.lit = lb.lit.slice(0, lb.lit.length - m.length); }
                    }
                    const cleaned = body.filter(p => !('lit' in p) || p.lit);
                    const value = partsToValue(cleaned);
                    const key = ctx.alloc(keyBase(hint), value, meta(hint));
                    const args = cleaned.filter(p => !('lit' in p));
                    if (lead) els.push(JSON.stringify({ text: lead }));
                    if (args.length) {
                        usesRuntime = true;
                        els.push(`{"translate":${JSON.stringify(key)},"with":{"rawtext":[${args.map(a => `${RT}.T(${renderPart(a)})`).join(',')}]}}`);
                    } else {
                        els.push(JSON.stringify({ translate: key }));
                        if (!line.some(p => !('lit' in p))) exact.push([litText(cleaned), key]);
                    }
                    if (tail) els.push(JSON.stringify({ text: tail }));
                    translated = true;
                } else {
                    for (const p of line) {
                        if ('lit' in p) els.push(JSON.stringify({ text: p.lit }));
                        else { usesRuntime = true; els.push(`${RT}.T(${renderPart(p)})`); }
                    }
                }
            });
            const hasDynamic = parts.some(p => !('lit' in p));
            if (!translated && !hasDynamic) return null;
            return els;
        }

        /** 处理一个“显示参数”表达式 */
        function transformSinkExpr(e, hint) {
            if (!e || e.type === 'SpreadElement') return;
            if (isStr(e) || e.type === 'TemplateLiteral' || (e.type === 'BinaryExpression' && e.operator === '+')) {
                const parts = isStr(e) ? [{ lit: e.value }] : flattenConcat(e);
                if (parts) {
                    if (!parts.some(p => 'lit' in p)) { wrapM(e); return; }
                    const els = buildElements(parts, hint);
                    if (els) {
                        markHandled(e);
                        overrides.set(e, () => `{"rawtext":[${els.join(',')}]}`);
                    }
                    return;
                }
            }
            if (e.type === 'ConditionalExpression') {
                transformSinkExpr(e.consequent, hint);
                transformSinkExpr(e.alternate, hint);
                return;
            }
            if (e.type === 'ParenthesizedExpression') { transformSinkExpr(e.expression, hint); return; }
            if (e.type === 'ObjectExpression' || e.type === 'Literal' || e.type === 'ArrowFunctionExpression' ||
                e.type === 'FunctionExpression' || e.type === 'ArrayExpression') return;
            wrapM(e);
        }

        function wrapM(e) {
            if (!injectRuntime) return;
            usesRuntime = true;
            overrides.set(e, () => `${RT}.M(${renderOrig(e)})`);
        }

        /** 处理 runCommand 的参数 */
        function transformCommandExpr(e) {
            if (isStr(e)) {
                const r = translateCommand(e.value, ctx, keyBase('command'), file);
                if (r.changed) { markHandled(e); overrides.set(e, () => JSON.stringify(r.cmd)); }
                return;
            }
            const parts = (e.type === 'TemplateLiteral' || (e.type === 'BinaryExpression' && e.operator === '+')) ? flattenConcat(e) : null;
            if (parts) {
                const exprs = [];
                const cmd = parts.map(p => ('lit' in p) ? p.lit : `${exprs.push(p) - 1}`).join('');
                const r = translateCommand(cmd, ctx, keyBase('command'), file);
                if (r.changed) {
                    markHandled(e);
                    // 整个 {"text":"<占位>"} 节点 → 运行时 TJ(expr)，动态值本身也能被翻译
                    const cmdOut = r.cmd.replace(/\{"text":"(?:(\d+)|(\d+))"\}/g, (all, a, b) => `${a || b}`);
                    if (cmdOut !== r.cmd) usesRuntime = true;
                    overrides.set(e, () => {
                        const out = cmdOut.split(/(\d+|\d+|\d+)/).map(seg => {
                            let m;
                            if ((m = /^(\d+)$/.exec(seg))) return '${' + RT + '.TJ(' + renderPart(exprs[+m[1]]) + ')}';
                            if ((m = /^(\d+)$/.exec(seg))) return '${' + renderPart(exprs[+m[1]]) + '}';
                            if ((m = /^(\d+)$/.exec(seg))) { usesRuntime = true; return '${' + RT + '.J(' + renderPart(exprs[+m[1]]) + ')}'; }
                            return templateEscape(seg);
                        }).join('');
                        return '`' + out + '`';
                    });
                    // J() 的使用在生成时才确定，这里提前标记
                    if (/\d+/.test(r.cmd)) usesRuntime = true;
                }
                return;
            }
            if (injectRuntime && e.type !== 'Literal') {
                usesRuntime = true;
                overrides.set(e, () => `${RT}.C(${renderOrig(e)})`);
            }
        }

        // ---- 第一遍：显示类 API ----
        walk(ast, (n) => {
            if (n.type === 'CallExpression') {
                const name = calleeName(n);
                const spec = name && Object.prototype.hasOwnProperty.call(SINKS, name) ? SINKS[name] : null;
                if (spec && n.callee.type === 'MemberExpression') {
                    const definitelyForm = spec.kind === 'form' && rootIsForm(n.callee.object);
                    if (spec.kind === 'form' && !definitelyForm && !formEnabled) return;
                    if (!definitelyForm && colliding.has(name)) {
                        if (!warnedCollide.has(name)) {
                            warnedCollide.add(name);
                            ctx.warn(`${file}: 脚本中自定义了同名方法 ${name}()，为避免误改，未处理无法确认类型的 .${name}() 调用`);
                        }
                        return;
                    }
                    const hint = name.toLowerCase();
                    if (spec.kind === 'cmd') {
                        if (n.arguments[0]) transformCommandExpr(n.arguments[0]);
                        return;
                    }
                    (spec.args || []).forEach(i => transformSinkExpr(n.arguments[i], hint));
                    (spec.arrays || []).forEach(i => {
                        const a = n.arguments[i];
                        if (!a) return;
                        if (a.type === 'ArrayExpression') a.elements.forEach(el => transformSinkExpr(el, hint));
                        else if (injectRuntime && a.type !== 'SpreadElement') {
                            usesRuntime = true;
                            overrides.set(a, () => `${RT}.MA(${renderOrig(a)})`);
                        }
                    });
                    if (spec.optKeys) {
                        n.arguments.forEach((a, i) => {
                            if (i === 0 || !a || a.type !== 'ObjectExpression') return;
                            for (const prop of a.properties) {
                                if (prop.type === 'Property' && !prop.computed && spec.optKeys.includes(prop.key.name || prop.key.value)) {
                                    transformSinkExpr(prop.value, hint);
                                }
                            }
                        });
                    }
                }
                // 无法翻译的显示位置：记录
                if (name && UNTRANSLATABLE_CALLS[name]) {
                    const args = name === 'addObjective' ? [n.arguments[1]] :
                        (n.arguments[0] && n.arguments[0].type === 'ArrayExpression' ? n.arguments[0].elements : [n.arguments[0]]);
                    for (const a of args) {
                        if (isStr(a) && looksLikeText(a.value)) ctx.report(file, `${name}()`, a.value, `${UNTRANSLATABLE_CALLS[name]}不支持翻译键`);
                    }
                }
            }
            if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' &&
                UNTRANSLATABLE_ASSIGN.has(propName(n.left)) && isStr(n.right) && looksLikeText(n.right.value)) {
                ctx.report(file, `.${propName(n.left)} =`, n.right.value, '名称标签只能是纯文本，不支持翻译键');
            }
        });

        // ---- 第二遍：脚本里手写的 RawMessage 对象 {rawtext:[{text:"..."}]} ----
        walk(ast, (n) => {
            if (n.type !== 'Property' || n.computed) return;
            const k = n.key.name || n.key.value;
            if (k === 'translate' && isStr(n.value)) { ctx.ref(n.value.value, file); markHandled(n.value); return; }
            if (k !== 'rawtext' || n.value.type !== 'ArrayExpression') return;
            for (const el of n.value.elements) {
                if (!el || el.type !== 'ObjectExpression' || el.properties.length !== 1) continue;
                const p = el.properties[0];
                if (p.type !== 'Property' || p.computed || (p.key.name || p.key.value) !== 'text' || !isStr(p.value)) continue;
                const parts = ctx.rawParts(p.value.value, keyBase('rawtext'), meta('rawtext'));
                if (!parts) continue;
                markHandled(el);
                overrides.set(el, () => parts.map(x => JSON.stringify(x)).join(','));
                const tr = parts.filter(x => x.translate);
                if (tr.length === 1 && parts.length === 1) exact.push([p.value.value, tr[0].translate]);
            }
        });

        // ---- 脚本自带的多语言表：同一句话的各语言版本共用一个键 ----
        const lf = opts.langFields || { mode: 'auto', map: new Map(), fileMaps: [] };
        const fileMap = new Map(lf.map);
        for (const [pat, m] of lf.fileMaps || []) {
            if (file.endsWith('/' + pat) || file === pat || file.split('/').pop() === pat) for (const [k, v] of m) fileMap.set(k, v);
        }
        const tables = collectTranslationGroups(ast, { mode: lf.mode === 'manual' && !fileMap.size ? 'auto' : lf.mode, map: fileMap, fileHint: langHintFromFile(file) });
        let tableEntries = 0;
        // 句式规则：英文句式与译文句式共用一个键，运行时两种原文都能匹配
        const toValue = (parts) => parts.map(x => x.lit != null ? x.lit.replace(/%/g, '%%') : `%${x.g}$s`).join('');
        const toLits = (parts) => {
            const lits = [''], order = [];
            for (const x of parts) { if (x.lit != null) lits[lits.length - 1] += x.lit; else { order.push(x.g); lits.push(''); } }
            return { lits, order };
        };
        // 占位符：${name}（模板字面量写法）或 {0}（运行时 replaceAll 填入）
        const PH = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{(\d{1,2})\}/g;
        for (const g of tables.groups) {
            const nodes = [...g.values()].filter(nd => !handled.has(nd));
            if (nodes.length < (g.fromDict ? 1 : 2)) continue;
            // 字符串里带 ${name} 占位符（脚本运行时才填入）→ 按句式登记，按占位符名字对齐参数
            const srcEntry = g.has('en_US') ? ['en_US', g.get('en_US')] : [...g.entries()][0];
            const names = [...srcEntry[1].value.matchAll(PH)].map(m => m[1] || '#' + m[2]);
            if (names.length) {
                const uniq = [...new Set(names)];
                const toParts = (text) => {
                    const parts = [];
                    let last = 0;
                    for (const m of text.matchAll(PH)) {
                        if (m.index > last) parts.push({ lit: text.slice(last, m.index) });
                        const gi = uniq.indexOf(m[1] || '#' + m[2]) + 1;
                        if (!gi) return null;
                        parts.push({ g: gi });
                        last = m.index + m[0].length;
                    }
                    if (last < text.length) parts.push({ lit: text.slice(last) });
                    return parts;
                };
                const all = [...g].map(([l, nd]) => [l, nd, toParts(nd.value)]);
                if (all.some(([, , ps]) => !ps)) continue;
                const key = ctx.alloc(keyBase('fmt'), toValue(all.find(([l]) => l === srcEntry[0])[2]), meta('fmt'));
                for (const [l, nd, ps] of all) {
                    ctx.addTranslation(key, l, toValue(ps));
                    const t = toLits(ps);
                    patterns.push([key, t.lits, t.order]);
                    handled.add(nd);
                }
                tableEntries++;
                continue;
            }
            // 以英文为原文（没有英文时用第一列）
            const [firstLang, firstNode] = g.has('en_US') ? ['en_US', g.get('en_US')] : [...g.entries()][0];
            const key = ctx.alloc(keyBase('str'), firstNode.value, meta('str'));
            for (const [lang, nd] of g) {
                ctx.addTranslation(key, lang, nd.value);
                exact.push([nd.value, key]);
                handled.add(nd);
            }
            void firstLang;
            tableEntries++;
        }
        for (const r of tables.sentenceRules || []) {
            const key = ctx.alloc(keyBase('fmt'), toValue(r.src.parts), meta('fmt'));
            ctx.addTranslation(key, 'en_US', toValue(r.src.parts));
            ctx.addTranslation(key, r.lang, toValue(r.tr.parts));
            const a = toLits(r.src.parts), b = toLits(r.tr.parts);
            patterns.push([key, a.lits, a.order]);
            if (b.order.length || b.lits[0]) patterns.push([key, b.lits, b.order]);
            walk(r.node, (c) => handled.add(c));
            tableEntries++;
        }
        tables.notes.forEach(nt => ctx.warn(`${file}: ${nt}`));

        // ---- 玩家输入匹配表：只导出供补充其他语言的说法 ----
        for (const r of collectInputTables(ast, file)) ctx.inputTables.push(r);

        // ---- 第三遍：登记其余“像玩家文本”的字符串到运行时映射 ----
        // 属于玩家输入归一化表（INPUT_TERMS、WHOLE_INPUT、aliases…）的字符串不登记
        const INPUT_OWNER = /input|alias|synonym|keyword|pattern|trigger|fold|normali[sz]e|intent/i;
        const inputOwned = (node) => {
            let c = node.parent;
            for (let i = 0; i < 8 && c; i++, c = c.parent) {
                if (c.type === 'VariableDeclarator' && c.id && c.id.type === 'Identifier') return INPUT_OWNER.test(c.id.name);
                if (c.type === 'AssignmentExpression' && c.left.type === 'Identifier') return INPUT_OWNER.test(c.left.name);
                if (/Function|Statement|Program/.test(c.type)) return false;
            }
            return false;
        };
        const isTechPosition = (node) => {
            const p = node.parent;
            if (!p) return false;
            if (inputOwned(node)) return true;
            switch (p.type) {
                case 'ImportDeclaration': case 'ExportAllDeclaration': case 'ExportNamedDeclaration':
                case 'ImportExpression': case 'TaggedTemplateExpression':
                    return true;
                case 'Property': case 'PropertyDefinition': case 'MethodDefinition': {
                    if (p.key === node) return true;
                    const k = p.key && (p.key.name || p.key.value);
                    return typeof k === 'string' && TECH_PROPS.test(k);
                }
                case 'SwitchCase':
                    return p.test === node;
                case 'MemberExpression':
                    return p.property === node;
                case 'BinaryExpression':
                    return ['===', '==', '!==', '!=', 'in', 'instanceof'].includes(p.operator);
                case 'ExpressionStatement':
                    return !!p.directive;
                case 'ArrayExpression':
                    // [/正则/, "替换成的内部标记"] —— 输入归一化表，不是显示文本
                    return p.elements.some(e => e && e.type === 'Literal' && e.regex);
                case 'CallExpression': case 'NewExpression': {
                    if (p.callee === node) return false;
                    const nm = p.type === 'NewExpression'
                        ? (p.callee.type === 'Identifier' ? p.callee.name : propName(p.callee))
                        : calleeName(p);
                    if (nm && TECH_CALLS.has(nm)) return true;
                    if (p.callee.type === 'MemberExpression' && p.callee.object.type === 'Identifier' && p.callee.object.name === 'console') return true;
                    return false;
                }
                default:
                    return false;
            }
        };

        const registerExact = (text, fromSplit = false) => {
            const lines = ctx.splitNewlines ? text.split(/\r?\n/) : [text];
            for (const line of lines) {
                if (!looksLikeText(line, 'strict')) continue;
                if (ctx.isKey(line)) continue;
                // 拆行时每行去掉代码缩进；原样和去空白后的写法都登记
                const t = (lines.length > 1 || fromSplit) ? line.trim() : line;
                const k = ctx.alloc(keyBase('str'), t, meta('str'));
                exact.push([line, k]);
                if (t !== line) exact.push([t, k]);
            }
        };
        const registerPattern = (parts) => {
            const lines = ctx.splitNewlines ? splitLines(parts) : [parts];
            for (const line of lines) {
                if (!line.length) continue;
                const hasExpr = line.some(p => !('lit' in p));
                if (!hasExpr) { registerExact(litText(line), lines.length > 1); continue; }
                if (!looksLikeText(litText(line), 'strict')) continue;
                // 字面量片段：表达式之间的文字（相邻表达式之间为空串）
                const lits = [''];
                for (const p of line) {
                    if ('lit' in p) lits[lits.length - 1] += p.lit;
                    else lits.push('');
                }
                const key = ctx.alloc(keyBase('fmt'), partsToValue(line), meta('fmt'));
                patterns.push([key, lits]);
            }
        };
        const commandTexts = (cmd) => {
            // 用一个临时上下文“试运行”命令处理，取出其中的文本
            const tmp = new NS.ExtractContext({ knownKeys: ctx.knownKeys, splitNewlines: ctx.splitNewlines });
            translateCommand(cmd, tmp, 'tmp', file);
            return [...tmp.entries.values()].map(e => e.value);
        };

        const isPlusOperand = (n) => n.parent && n.parent.type === 'BinaryExpression' && n.parent.operator === '+';
        walk(ast, (n) => {
            if (handled.has(n)) return;
            if (isStr(n)) {
                if (isPlusOperand(n)) return;   // 属于某个拼接句式，由拼接根节点统一登记
                if (isTechPosition(n)) return;
                const v = n.value;
                if (looksLikeCommand(v)) { commandTexts(v).forEach(registerExact); return; }
                registerExact(v);
                return;
            }
            const isConcatRoot = (n.type === 'TemplateLiteral' && !isPlusOperand(n) && !(n.parent && n.parent.type === 'TaggedTemplateExpression')) ||
                (n.type === 'BinaryExpression' && n.operator === '+' && !(isPlusOperand(n) && n.parent.left === n));
            if (isConcatRoot) {
                if (isTechPosition(n)) return;
                const parts = flattenConcat(n);
                if (!parts || !parts.some(p => 'lit' in p)) return;
                // 动态部分用 0 代入后整体判断（如 `setblock ${x} 69 -20 stone`）
                if (looksLikeCommand(parts.map(p => ('lit' in p) ? p.lit : '0').join(''))) return;
                registerPattern(parts);
            }
        });

        // 跨文件预扫描得到的参数文字（如默认值 'item'、调用处传入的 'block'）
        for (const t of opts.paramTexts || []) {
            if (ctx.isKey(t) || exact.some(([x]) => x === t)) continue;
            exact.push([t, ctx.alloc(keyBase('word'), t, meta('word'))]);
        }

        // ---- 生成输出 ----
        const hasRegistrations = exact.length > 0 || patterns.length > 0;
        if (overrides.size === 0 && !hasRegistrations) return { content: source, changed: false };

        let body = renderOrig(ast);
        let prelude = '';
        if (injectRuntime && (usesRuntime || hasRegistrations)) {
            prelude = buildRuntime(RT, opts.runtimeKey || '__ADDON_I18N__');
            if (hasRegistrations) {
                const ex = [];
                const seen = new Set();
                for (const [s, k] of exact) { if (!seen.has(s)) { seen.add(s); ex.push([s, k]); } }
                prelude += `${RT}.reg(${JSON.stringify(ex)}, ${JSON.stringify(patterns)});\n`;
            }
        } else if (usesRuntime) {
            // 不注入运行时却用到了 → 不应发生，保险起见放弃改写
            ctx.warn(`${file}: 内部错误，未写入改动`);
            return { content: source, changed: false };
        }
        if (!injectRuntime && overrides.size === 0) return { content: source, changed: false };

        // 保留 #! 行
        let head = '';
        if (body.startsWith('#!')) {
            const nl = body.indexOf('\n');
            head = body.slice(0, nl + 1);
            body = body.slice(nl + 1);
        }
        const content = head + (prelude ? `// ---- i18n runtime (auto-generated) ----\n${prelude}// ---- end i18n runtime ----\n` : '') + body;
        return { content, changed: true, stats: { overrides: overrides.size, exact: exact.length, patterns: patterns.length, tables: tableEntries } };
    }

    NS.collectScriptInfo = collectScriptInfo;
    NS.guessLang = guessLang;
    NS.regexPhrases = regexPhrases;
    NS.langHintFromFile = langHintFromFile;
    NS.collectTranslationGroups = collectTranslationGroups;
    NS.processScript = processScript;
    NS.collectParamTexts = collectParamTexts;
    NS.SCRIPT_SINKS = SINKS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
