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
    const { looksLikeText, fileBaseOf, translateCommand, looksLikeCommand, sanitizeKeyPart, hasCJK } = NS;

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
    const TECH_PROPS = /^(patterns?|keywords?|triggers?|aliases|synonyms|regex(es)?|regexp|match(es)?|intent|intents|id|typeId|identifier|type|icon|iconPath|texture|image|path|sound|event|tag|tags|objective|permission|defaultValue|key|namespace|entity|item|block|dimension|mode|command|cmd|url|uuid|color|font|username|userName|playerName|gamertag|xuid)$/i;
    // 这些字段的值不带空格时（"Ready"、"melee"）是内部取值；带空格的（role: "Arcane caster"）照常当文字
    const TECH_PROPS_WORD = /^(kind|phase|clip|role|playback|policy|stat)$/i;
    // retailId、skillKey、hitSound、trailParticle 这类驼峰后缀：内部标识，不是显示文本
    const TECH_SUFFIX = /[a-z0-9](Id|ID|Ids|IDs|Key|Keys|Type|Types|Path|File|Files|Sound|Sounds|Particle|Particles|Texture|Geometry|Clip|Locator|Locators|Tag|Tags|Event|Events|Identifier)$/;
    // 开发备注字段：adaptation / notes / timingBasis: {…} 等（字段本身或所在对象的字段名命中都算）
    const DEV_NOTE_KEY = /^(todo|fixme|adaptation|evidence|rationale|provenance|basis|changelog)$|^(debug|dev|internal|meta)([A-Z_]|$)|[a-z](Basis|Evidence|Debug|Timing)$/;
    // 调试相关：字符串（如标签 "dungeons:debug_damage"）、变量 / 函数名（DEBUG、isDebug、debugLog、devMode）
    const DEBUG_STR = /(^|[^a-z])(debug|dbg)/i;
    const DEBUG_ID = /debug|dbg|^dev(_?mode)?$|devMode|^is_?dev$/i;
    // 整个文件都是调试用（debug.js、dev-tools.js、test/…）
    const DEBUG_FILE = /(^|\/)(debug|dbg|devtools?|dev[-_]tools?|tests?)(\/|[._-][^\/]*$|\.[cm]?js$)/i;

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
    /**
     * 原版 ID（或旧式写法）→ 游戏自带翻译键；英文必须和给定文字一致（作者改过名的不替换）
     * @param {'item'|'block'|'entity'} kind
     */
    let vanillaByValue = null;
    NS.vanillaKeyFor = function (id, kind, value) {
        const V = NS.VANILLA;
        if (!V || typeof value !== 'string') return null;
        const ns = id.indexOf(':') >= 0 ? id.split(':')[0] : 'minecraft';
        if (ns !== 'minecraft') return null;
        const full = id.indexOf(':') >= 0 ? id : 'minecraft:' + id;
        const want = value.replace(/§./g, '').trim().toLowerCase();
        const ok = (k) => k && V.en[k] && V.en[k].trim().toLowerCase() === want;
        const k1 = kind === 'entity' ? V.ents[full] : (V.ids[full] || V.ents[full]);
        if (ok(k1)) return k1;
        // 旧式 / 自造的写法（appleEnchanted、porkchop_cooked）：按英文名在同类键里找唯一的一个
        if (!vanillaByValue) {
            vanillaByValue = new Map();
            for (const [k, v] of Object.entries(V.en)) {
                const t = v.trim().toLowerCase();
                if (!vanillaByValue.has(t)) vanillaByValue.set(t, []);
                vanillaByValue.get(t).push(k);
            }
        }
        const pre = kind === 'entity' ? /^entity\./ : kind === 'block' ? /^tile\./ : /^(item|tile)\./;
        const ks = (vanillaByValue.get(want) || []).filter(k => pre.test(k) && /\.name$/.test(k) && !/spawn_egg/.test(k));
        return ks.length === 1 ? ks[0] : null;
    };

    // 脚本字典的 @引用 / $变量 记号（见 collectCrossFileDicts）
    const DICT_REF = /@[A-Za-z0-9_\-$#]*[.:][A-Za-z0-9_.:\-$#]*[A-Za-z0-9_\-#]|\$#?[A-Za-z0-9_]+#?/g;
    /** 把字面量片段里的 @引用 / $变量 拆成占位（{ ref }），运行时由作者解析后的文字按句式匹配 */
    function splitDictRefs(parts) {
        const out = [];
        let any = false;
        // 先把跨表达式拼出来的引用合成一个占位：`@attributes.${id}.name`、`@items.${id}§r`
        const merged = [];
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            const m = 'lit' in p && i + 1 < parts.length && !('lit' in parts[i + 1]) ? /@[A-Za-z0-9_\-$#]*(?:[.:][A-Za-z0-9_\-$#]+)*[.:]$/.exec(p.lit) : null;
            if (!m) { merged.push(p); continue; }
            if (m.index > 0) merged.push({ lit: p.lit.slice(0, m.index) });
            let j = i + 1;
            while (j < parts.length && !('lit' in parts[j])) j++;   // 连续的表达式
            const nx = j < parts.length ? parts[j] : null;
            const cont = nx ? /^(?:[.:][A-Za-z0-9_\-$#]+)*/.exec(nx.lit)[0] : '';
            merged.push({ ref: '@dynamic' });
            any = true;
            if (nx) { const rest = nx.lit.slice(cont.length); if (rest) merged.push({ lit: rest }); j++; }
            i = j - 1;
        }
        parts = merged;
        for (const p of parts) {
            if (!('lit' in p)) { out.push(p); continue; }
            let last = 0;
            for (const m of p.lit.matchAll(DICT_REF)) {
                let a = m.index, b = a + m[0].length;
                if (m[0].startsWith('$#') && a > 0) a--;
                if (m[0].endsWith('#') && p.lit[b] === ' ') b++;
                if (a > last) out.push({ lit: p.lit.slice(last, a) });
                out.push({ ref: m[0] });
                any = true;
                last = b;
            }
            if (last < p.lit.length) out.push({ lit: p.lit.slice(last) });
        }
        return any ? out : null;
    }

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
        tr: 'tr_TR', tr_tr: 'tr_TR', pl: 'pl_PL', pl_pl: 'pl_PL', uk: 'uk_UA', uk_ua: 'uk_UA', nl: 'nl_NL', nl_nl: 'nl_NL', id_id: 'id_ID',
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
        for (const tok of base.toLowerCase().split(/[_\-.]+/)) if (Object.prototype.hasOwnProperty.call(NAMES, tok)) return NAMES[tok];
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
        const ignoredNodes = new Set();   // 残留的无用字典条目：不提取
        const userMap = (fieldMode && fieldMode.map) || new Map();
        if (fieldMode && fieldMode.mode === 'off') return { groups, notes, sentenceRules, ignoredNodes };

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
            // 没有英文版本的条目：只有代码里用到这个字典键时才保留
            // （作者改了键名后，其他语言字典里常残留旧键，如 gluttony_ring ↔ 英文的 gluttony_rings）
            let usedKey = null;
            const isUsed = (path) => {
                if (!usedKey) {
                    const lits = new Set(), pats = [];
                    walk(ast, (x) => {
                        if (isStr(x) && x.parent && x.parent.type !== 'Property') lits.add(x.value);
                        else if (isStr(x) && x.parent && x.parent.type === 'Property' && x.parent.value === x) lits.add(x.value);
                        else if (x.type === 'BinaryExpression' && x.operator === '+' && !(x.parent && x.parent.type === 'BinaryExpression' && x.parent.operator === '+')) {
                            // "guide.mob." + t + ".name" 这类拼接出来的键
                            const parts = [];
                            const flat = (e) => { if (e.type === 'BinaryExpression' && e.operator === '+') { flat(e.left); flat(e.right); } else parts.push(e); };
                            flat(x);
                            if (parts.some(isStr)) {
                                const src = parts.map(e => isStr(e) ? e.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '.+').join('');
                                if (src.replace(/\.\+/g, '').length >= 4) pats.push(new RegExp('^' + src + '$'));
                            }
                        }
                        else if (x.type === 'TemplateLiteral' && x.expressions.length) {
                            const q = x.quasis.map(t => (t.value.cooked || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                            if (q.join('').length >= 4) pats.push(new RegExp('^' + q.join('.+') + '$'));
                        }
                    });
                    usedKey = (k) => lits.has(k) || pats.some(r => r.test(k));
                }
                const k = path.replace(/^\./, '');
                return usedKey(k);
            };
            let orphan = 0;
            for (const [path, m] of byPath) {
                if (!m.has('en_US') && /^\.[^.[\]]+(\.[^.[\]]+)+$/.test(path) && !isUsed(path)) { orphan++; continue; }
                const vals = [...m.values()].map(nd => nd.value);
                if (m.size >= 2 && new Set(vals).size > 1 && vals.some(v => looksLikeText(v, 'loose'))) { m.fromDict = true; groups.push(m); n++; }
                // 只有某种非英语字典里才有的条目（作者没写英文）→ 也归到该语言
                else if (m.size === 1 && !m.has('en_US') && looksLikeText(vals[0], 'loose')) { m.fromDict = true; groups.push(m); n++; }
            }
            if (orphan) {
                notes.push(`${orphan} 条字典条目没有英文版本、代码中也没有用到（多为改名后残留的旧键），已忽略`);
                // 这些字符串不再作为普通文字提取
                const kept = new Set(groups); for (const m of byPath.values()) if (!m.has('en_US') && !kept.has(m)) for (const nd of m.values()) ignoredNodes.add(nd);
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
        return { groups, notes, sentenceRules, ignoredNodes };

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
  const m = new Map(), p = [], cache = new Map(), FUZZY_MAX = 600;
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
    // 下面是模糊匹配：太长、或去掉颜色码和图标字形后没有字母的（小地图、进度条这类字形画）直接放弃，
    // 否则每 tick 刷新的长字符串会让正则回溯卡死脚本（Watchdog hang）
    if (s.length > FUZZY_MAX || !/\\p{L}/u.test(s.replace(/\\u00a7./g, "").replace(/[\\ue000-\\uf8ff]/g, ""))) return null;
    const pat = (t) => {
      for (const [pk, re, , ord, lits] of p) {
        // 先用字面量片段快速排除：开头、结尾、中间片段按顺序都得出现
        const last = lits[lits.length - 1];
        if (!t.startsWith(lits[0]) || !t.endsWith(last)) continue;
        let at = lits[0].length, ok = true;
        for (let i = 1; i < lits.length - 1; i++) { if (!lits[i]) continue; const j = t.indexOf(lits[i], at); if (j < 0) { ok = false; break; } at = j + lits[i].length; }
        if (!ok || at > t.length - last.length) continue;
        const x = re.exec(t);
        if (!x) continue;
        let caps = x.slice(1);
        if (ord && ord.length) { const a = []; ord.forEach((g, i) => { if (a[g - 1] === undefined) a[g - 1] = caps[i]; }); for (let i = 0; i < a.length; i++) if (a[i] === undefined) a[i] = ""; caps = a; }
        return [{ translate: pk, with: { rawtext: caps.map(T) } }];
      }
      return null;
    };
    let r = pat(s);
    if (r) return r;
    // 句式两端多了颜色码（如 "§c" + reason）
    if (mm && mm[2] !== s && mm[2] && (r = pat(mm[2]))) {
      if (mm[1]) r.unshift({ text: mm[1] });
      if (mm[3]) r.push({ text: mm[3] });
      return r;
    }
    // 数值 + 名称（如 "+2.5 skill xp"、"12 xp"）：名称认识时只翻名称，数字和符号原样保留
    const nm = /^((?:\\u00a7.|[\\s\\d+\\-.,%:\\/()\\ue000-\\uf8ff])*)([\\s\\S]*?)((?:\\u00a7.|[\\s\\d+\\-.,%:\\/()\\ue000-\\uf8ff])*)$/.exec(s);
    if (nm && nm[2] && nm[2] !== s && /\\d/.test(nm[1] + nm[3]) && (k = m.get(nm[2]))) {
      const r3 = [{ translate: k }];
      if (nm[1]) r3.unshift({ text: nm[1] });
      if (nm[3]) r3.push({ text: nm[3] });
      return r3;
    }
    // 颜色码被代码替换过（如浅色背景下把 §7 换成 §8）：忽略颜色码再比一次，用原文的颜色
    const core = mm ? mm[2] : s;
    const sf = F(core);
    if (sf && /[^\s\d\p{P}]/u.test(sf)) {
      if (!cf) { cf = new Map(); for (const [t, kk] of m) { const f = F(t); if (f && !cf.has(f)) cf.set(f, kk); } }
      if ((k = cf.get(sf))) {
        const r2 = [{ translate: k }];
        // 原文自带颜色码，两端只补回空白
        const w1 = mm ? F2(mm[1]) : "", w3 = mm ? F2(mm[3]) : "";
        if (w1) r2.unshift({ text: w1 });
        if (w3) r2.push({ text: w3 });
        return r2;
      }
    }
    return runs(s) || list(s);
  };
  // 按颜色码分段，每段都认识（或没有文字）时逐段翻译："§a+2 max health §8[flat]§r"
  const runs = (s) => {
    const parts = s.split(/(\\u00a7.)/);
    if (parts.length < 3) return null;
    const els = []; let hit = false;
    for (const x of parts) {
      if (!x) continue;
      if (/^\\u00a7.$/.test(x) || !/[^\\s\\d\\p{P}\\p{S}]/u.test(x)) { els.push({ text: x }); continue; }
      const nm2 = /^([\\s\\d+\\-.,%:\\/()]*)([\\s\\S]*?)([\\s\\d+\\-.,%:\\/()]*)$/.exec(x);
      const k2 = m.get(x) || (nm2 && m.get(nm2[2]));
      if (!k2) return null;
      hit = true;
      if (!m.get(x) && nm2[1]) els.push({ text: nm2[1] });
      els.push({ translate: k2 });
      if (!m.get(x) && nm2[3]) els.push({ text: nm2[3] });
    }
    return hit ? els : null;
  };
  const F = (t) => t.replace(/\u00a7./g, "").trim();
  const F2 = (t) => t.replace(/\u00a7./g, "");
  let cf = null;
  // 用逗号 / 分号 / 竖线等拼起来的列表（如 names.join(", ")）：每一项都认识时逐项翻译
  // join("§7 or §f") 这类带文字的分隔符（静态扫描时登记）
  const seps = [];
  const list = (s) => {
    const alt = seps.filter((x) => s.indexOf(x) >= 0).map(esc);
    const parts = s.split(new RegExp("(" + (alt.length ? alt.join("|") + "|" : "") + "(?:\\\\s|\\u00a7.)*[,;|\\u00b7\\u2022\\\\/\\uff0c\\u3001](?:\\\\s|\\u00a7.)*)"));
    if (parts.length < 3) return null;
    const els = [];
    for (let i = 0; i < parts.length; i++) {
      const x = parts[i];
      if (i % 2) {
        if (/[A-Za-z\\u00c0-\\uffff]{2,}/.test(x.replace(/\\u00a7./g, ""))) { const t = one(x); if (t) { els.push(...t); continue; } }
        els.push({ text: x }); continue;
      }
      if (!x) continue;
      let k = m.get(x), y = null;
      if (k) y = [{ translate: k }];
      else {
        const mm = /^((?:\\u00a7.|\\s)*)([\\s\\S]*?)((?:\\u00a7.|\\s)*)$/.exec(x);
        if (mm && (k = m.get(mm[2]))) { y = [{ translate: k }]; if (mm[1]) y.unshift({ text: mm[1] }); if (mm[3]) y.push({ text: mm[3] }); }
      }
      if (!y) return null;
      els.push(...y);
    }
    return els;
  };
  const lookup = (s) => {
    if (cache.has(s)) return cache.get(s);
    let r = one(s);
    if (!r && s.indexOf("\\n") >= 0) {
      // 自动换行过的文字（作者按宽度把空格换成了换行）：换行还原成空格再找
      const un = (t) => t.indexOf("\\n") >= 0 ? one(t.replace(/\\n/g, " ")) : null;
      const lines = (t, els) => {
        let hit = false;
        t.split("\\n").forEach((l, i) => {
          if (i) els.push({ text: "\\n" });
          if (!l) return;
          const x = one(l);
          if (x) { hit = true; els.push(...x); } else els.push({ text: l });
        });
        return hit;
      };
      if (s.indexOf("\\u00a7r\\n") < 0) r = un(s);
      if (!r) {
        // 多条拼在一起的（动作栏 "§r\\n" 分隔）：逐条找，每条再试还原换行、逐行
        const blocks = s.split("\\u00a7r\\n");
        const els = []; let hit = false;
        blocks.forEach((b, i) => {
          if (i) els.push({ text: "\\u00a7r\\n" });
          if (!b) return;
          const x = blocks.length > 1 ? (one(b) || un(b)) : null;
          if (x) { hit = true; els.push(...x); return; }
          if (lines(b, els)) hit = true;
        });
        if (hit) r = els;
      }
    }
    r = r ? { rawtext: r } : null;
    // 满了只丢最早的一批，不整个清空（每帧都变的字符串不会把常用文本挤掉）
    if (cache.size >= 2000) { let n = 0; for (const x of cache.keys()) { cache.delete(x); if (++n >= 500) break; } }
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
  const reg = (exact, pats, sp) => {
    cf = null;
    if (sp) for (const x of sp) if (seps.indexOf(x) < 0) seps.push(x);
    for (const [s, k] of exact) {
      if (!m.has(s)) m.set(s, k);
      if (s.indexOf("\\n") >= 0 && !m.has(N(s))) m.set(N(s), k);
    }
    for (const [k, lits, ord] of pats) {
      const len = lits.join("").length;
      p.push([k, new RegExp("^" + lits.map(esc).join("([\\\\s\\\\S]*?)") + "$"), len, ord, lits]);
    }
    p.sort((a, b) => b[2] - a[2]);
    cache.clear();
  };
  // 把 ID 拼成英文名的函数（"minecraft:iron_sword" → "Iron Sword"）：记下这段文字对应的翻译键
  const ids = new Map(), ents = new Map();
  const H = (id, text) => {
    if (typeof id === "string" && typeof text === "string" && text) {
      const full = id.indexOf(":") >= 0 ? id : "minecraft:" + id;
      const k = ids.get(full) || ents.get(full);
      if (k && m.get(text) !== k) { m.set(text, k); cache.delete(text); }
    }
    return text;
  };
  const regIds = (a, b) => {
    for (const k in a || {}) ids.set(k, a[k]);
    for (const k in b || {}) ents.set(k, b[k]);
  };
  return (g[K] = { T, M, MA, J, TJ, C, reg, H, regIds });
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
    /**
     * 固定长度 ASCII 数据包式 HUD（PalCraft 等）：脚本把各字段拼成一串纯 ASCII 字符，
     * 资源包界面按字符位置截取显示。非 ASCII 字符会被替换、长度被截断，翻译键（rawtext）也塞不进去，
     * 所以流进这些字段的文字无法本地化。
     * 识别：
     *   ① 去掉非 ASCII 的函数（函数体里有 /[^\x20-\x7e]/ 这类正则）→ 调用它时参数里的文字；
     *   ② 和这类函数在同一文件的字段宽度表 [['name', 20], ['hint', 28], …] → 所有文件里以这些字段名为键的对象属性值里的文字
     *      （值里调用了同文件函数的，连同那个函数 return 的文字）。
     * 返回 Map(文字 → Set(文件))
     */
    function collectAsciiPacketTexts(infos) {
        const out = new Map();
        const sanitizers = new Set();
        const fields = new Set();
        const ASCII_RE = /\[\^(?:\\x20-\\x7e|\\x00-\\x7f|\\x20-~| -~)/i;
        const fnOf = (n) => /Function/.test(n.type) ? n : null;
        const fnName = (f) => {
            if (f.id && f.id.name) return f.id.name;
            const q = f.parent;
            if (q && q.type === 'VariableDeclarator' && q.id.type === 'Identifier') return q.id.name;
            if (q && q.type === 'Property' && q.key) return q.key.name || q.key.value;
            return '';
        };
        for (const [, info] of infos) {
            if (!info.ok || !info.ast) continue;
            let hasSan = false;
            walk(info.ast, (n) => {
                const f = fnOf(n);
                if (!f) return;
                let hit = false;
                walk(f.body, (x) => { if (!hit && x.type === 'Literal' && x.regex && ASCII_RE.test(x.regex.pattern)) hit = true; });
                if (hit) { const nm = fnName(f); if (nm) { sanitizers.add(nm); hasSan = true; } }
            });
            if (!hasSan) continue;
            // 字段宽度表：至少 5 行 ['字段名', 数字]
            walk(info.ast, (n) => {
                if (n.type !== 'ArrayExpression') return;
                const rows = n.elements.filter(e => e && e.type === 'ArrayExpression' && e.elements.length === 2 && isStr(e.elements[0]) && e.elements[1] && e.elements[1].type === 'Literal' && typeof e.elements[1].value === 'number');
                if (rows.length >= 5) for (const r of rows) fields.add(r.elements[0].value);
            });
        }
        if (!sanitizers.size) return out;
        const gather = (expr, file, fns, depth) => {
            const stack = [expr];
            while (stack.length) {
                const x = stack.pop();
                if (!x) continue;
                const v = isStr(x) ? x.value : (x.type === 'TemplateLiteral' && !x.expressions.length ? x.quasis[0].value.cooked : null);
                if (v != null) { if (v.trim()) { if (!out.has(v)) out.set(v, new Set()); out.get(v).add(file); } continue; }
                if (/Function/.test(x.type)) continue;
                if (x.type === 'CallExpression' && x.callee.type === 'Identifier' && depth < 1 && fns.has(x.callee.name)) {
                    walk(fns.get(x.callee.name).body, (r) => { if (r.type === 'ReturnStatement' && r.argument) gather(r.argument, file, fns, depth + 1); });
                }
                stack.push(...childrenOf(x));
            }
        };
        for (const [file, info] of infos) {
            if (!info.ok || !info.ast) continue;
            const fns = new Map();
            walk(info.ast, (n) => { const f = fnOf(n); if (f) { const nm = fnName(f); if (nm && !fns.has(nm)) fns.set(nm, f); } });
            walk(info.ast, (n) => {
                if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && sanitizers.has(n.callee.name)) {
                    for (const a of n.arguments) gather(a, file, fns, 0);
                } else if (fields.size && n.type === 'Property' && !n.computed && n.parent && n.parent.type === 'ObjectExpression') {
                    const k = n.key.name || n.key.value;
                    if (typeof k === 'string' && fields.has(k) && !/Function/.test(n.value.type)) gather(n.value, file, fns, 0);
                }
            });
        }
        return out;
    }

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

    /**
     * 跨文件的语言字典：同一目录下按语言命名的脚本（en.js / es.js / ru.js / uk.js / zh_cn.js…），
     * 各自导出一个大对象（同样的键路径，不同语言的文字）。同一路径的各语言版本共用一个翻译键：
     * 原文用英文写进源语言 lang，其他语言写进对应 lang；运行时任何一种语言的文字都对应到这个键。
     * 返回 Map(文件 → { exact, patterns, nodes })，由 processScript 登记。
     */
    function collectCrossFileDicts(infos, ctx) {
        const out = new Map();
        const FILE_LANG = { it: 'it_IT' };
        const byDir = new Map();
        for (const [file, info] of infos) {
            if (!info || !info.ok) continue;
            const m = /^(.*\/)?([^/]+)\.(m?js)$/.exec(file);
            if (!m) continue;
            const lang = localeOfKey(m[2]) || FILE_LANG[m[2].toLowerCase()];
            if (!lang) continue;
            const dir = m[1] || '';
            if (!byDir.has(dir)) byDir.set(dir, []);
            byDir.get(dir).push({ file, lang, info });
        }
        for (const [dir, files] of byDir) {
            if (files.length < 2 || new Set(files.map(f => f.lang)).size < 2) continue;
            // 每个文件里最大的对象字面量（字符串叶子最多）
            const countLeaves = (o) => { let n = 0; walk(o, (x) => { if (isStr(x)) n++; }); return n; };
            const dicts = [];
            for (const f of files) {
                let best = null, bestN = 0;
                walk(f.info.ast, (n) => {
                    if (n.type !== 'VariableDeclarator' || !n.init || n.init.type !== 'ObjectExpression') return;
                    if (n.parent && n.parent.parent && !/Program|ExportNamedDeclaration/.test(n.parent.parent.type)) return;
                    const c = countLeaves(n.init);
                    if (c > bestN) { best = n.init; bestN = c; }
                });
                if (best && bestN >= 5) dicts.push({ ...f, obj: best, n: bestN });
            }
            if (dicts.length < 2) continue;
            const byPath = new Map();
            const collect = (node, d, path) => {
                if (isStr(node)) {
                    if (!byPath.has(path)) byPath.set(path, new Map());
                    byPath.get(path).set(d.lang, { node, file: d.file });
                } else if (node && node.type === 'ObjectExpression') {
                    for (const p of node.properties) { const k = p.type === 'Property' && !p.computed ? (p.key.name != null ? p.key.name : p.key.value) : null; if (k != null) collect(p.value, d, path ? `${path}.${k}` : String(k)); }
                } else if (node && node.type === 'ArrayExpression') node.elements.forEach((e, i) => collect(e, d, `${path}[${i}]`));
            };
            for (const d of dicts) collect(d.obj, d, '');
            const prefix = 'script.' + sanitizeKeyPart(dir.replace(/\/$/, '').split('/').pop() || 'langs');
            const add = (file, kind, v) => {
                if (!out.has(file)) out.set(file, { exact: [], patterns: [], nodes: new Set() });
                out.get(file)[kind].push(v);
            };
            const PH = /%(\d+)\$[sd]|%[sd]/g;
            // 字典自己的引用语法（RPG 等）：
            //   @路径      → 运行时换成字典里另一条（如 "@tile.sert:press"、"@items.$item"）
            //   $变量 / $变量#  → 换成传入的值（# 结尾时连同后面一个空格一起替换）
            // 这些在 lang 里无法解析，改成 %1$s 占位，运行时把作者解析好的整句按句式匹配，引用部分单独翻译
            // @引用至少带一个 . 或 :（排除 @s、@a 这类目标选择器）
            const REF = /@[A-Za-z0-9_\-$#]*[.:][A-Za-z0-9_.:\-$#]*[A-Za-z0-9_\-#]|\$#?[A-Za-z0-9_]+#?/g;
            const refsOf = (v) => {
                const toks = [];
                for (const mm of v.matchAll(REF)) {
                    let a = mm.index, b = a + mm[0].length;
                    if (mm[0].startsWith('$#') && a > 0) a--;
                    if (mm[0].endsWith('#') && v[b] === ' ') b++;
                    toks.push({ tok: mm[0], a, b });
                }
                return toks;
            };
            const refValue = (v, numOf) => {
                const toks = refsOf(v);
                const lits = [''], order = [];
                let last = 0, out = '';
                for (const t of toks) {
                    const lit = v.slice(last, t.a);
                    lits[lits.length - 1] += lit;
                    out += lit.replace(/%/g, '%%');
                    let n = numOf(t.tok);
                    if (!n) { lits[lits.length - 1] += v.slice(t.a, t.b); out += v.slice(t.a, t.b); last = t.b; continue; }
                    order.push(n);
                    lits.push('');
                    out += `%${n}$s`;
                    last = t.b;
                }
                lits[lits.length - 1] += v.slice(last);
                out += v.slice(last).replace(/%/g, '%%');
                return { lits, order, value: out };
            };
            let groups = 0, reused = 0, vanilla = 0;
            for (const [path, m] of byPath) {
                const src = m.get('en_US') || m.get('en_GB') || [...m.values()].find(x => !/[^\u0000-ɏ\s\p{P}\p{S}\p{N}]/u.test(x.node.value)) || [...m.values()][0];
                let value = src.node.value;
                for (const x of m.values()) out.has(x.file) || add(x.file, 'exact', null), out.get(x.file).nodes.add(x.node);
                if (!looksLikeText(value, 'loose') && ![...m.values()].some(x => hasCJK(x.node.value))) continue;
                // 带 @引用 / $变量 的条目
                const srcToks = PH.test(value) ? [] : refsOf(value);
                PH.lastIndex = 0;
                if (srcToks.length) {
                    if (/^@/.test(srcToks[0].tok) || srcToks.some(t => t.tok[0] === '@')) out.refSyntax = true;
                    const nums = new Map();
                    for (const t of srcToks) if (!nums.has(t.tok)) nums.set(t.tok, nums.size + 1);
                    const conv = refValue(value, (tok) => nums.get(tok));
                    // 整条只是引用（"@quests.defaultRewardDescription"、"@tile.a & @tile.b"）：显示的就是被引用条目，不单独提取
                    if (!conv.lits.some(l => /\p{L}/u.test(l))) continue;
                    const key = ctx.alloc(`${prefix}.${path.replace(/[^A-Za-z0-9_.:\-]/g, '_')}`, conv.value, { file: src.file, kind: 'script', scope: 'xdict:' + prefix + ':' + path });
                    groups++;
                    for (const [lang, x] of m) {
                        const c = x === src ? conv : refValue(x.node.value, (tok) => nums.get(tok));
                        ctx.addTranslation(key, lang, c.value);
                        add(x.file, 'patterns', [key, c.lits, c.order]);
                        // 作者的 translate() 会去掉结尾的一个句点
                        const lastLit = c.lits[c.lits.length - 1];
                        if (lastLit.endsWith('.')) add(x.file, 'patterns', [key, [...c.lits.slice(0, -1), lastLit.slice(0, -1)], c.order]);
                    }
                    continue;
                }
                // 资源包 lang 里已经有同路径、同内容的键（作者把字典也导出成了 lang）：直接用它，不再新建重复的键
                // 也认游戏自己的命名：mobs.<id> ↔ entity.<id>.name、tile.<id> ↔ tile.<id>.name、items.<id> ↔ item.<id>(.name)
                const cands = [path, `${path}.name`];
                const idm = /^(mobs|entities|tile|blocks|items?)\.(.+)$/.exec(path);
                if (idm) {
                    const id = idm[2];
                    if (/^(mobs|entities)$/.test(idm[1])) cands.push(`entity.${id}.name`);
                    else if (/^(tile|blocks)$/.test(idm[1])) cands.push(`tile.${id}.name`);
                    else cands.push(`item.${id}.name`, `item.${id}`, `tile.${id}.name`);
                }
                const same = (k) => { const ex = ctx.existingValues && ctx.existingValues.get(k); return ex && (ex.has(value) || ex.has(value.replace(/\r?\n/g, '\\n'))); };
                let reuse = cands.find(same);
                // 原版物品 / 方块 / 生物：用游戏自带的翻译键（所有语言都有），英文内容一致才用
                if (!reuse && idm && NS.vanillaKeyFor) reuse = NS.vanillaKeyFor(idm[2], /^(mobs|entities)$/.test(idm[1]) ? 'entity' : /^(tile|blocks)$/.test(idm[1]) ? 'block' : 'item', value);
                if (reuse && !cands.includes(reuse)) {
                    vanilla++;
                    for (const x of m.values()) {
                        add(x.file, 'exact', [x.node.value, reuse]);
                        if (/[^.]\.$/.test(x.node.value)) add(x.file, 'exact', [x.node.value.slice(0, -1), reuse]);
                    }
                    continue;
                }
                if (reuse) {
                    ctx.ref(reuse, src.file);
                    reused++;
                    for (const x of m.values()) {
                        add(x.file, 'exact', [x.node.value, reuse]);
                        if (/[^.]\.$/.test(x.node.value)) add(x.file, 'exact', [x.node.value.slice(0, -1), reuse]);
                    }
                    continue;
                }
                const key = ctx.alloc(`${prefix}.${path.replace(/[^A-Za-z0-9_.:\-]/g, '_')}`, value, { file: src.file, kind: 'script', scope: 'xdict:' + prefix + ':' + path });
                groups++;
                for (const [lang, x] of m) {
                    ctx.addTranslation(key, lang, x.node.value);
                    if (PH.test(x.node.value)) {
                        PH.lastIndex = 0;
                        const lits = [''], order = [];
                        let last = 0, seq = 0;
                        for (const mm of x.node.value.matchAll(PH)) {
                            lits[lits.length - 1] += x.node.value.slice(last, mm.index);
                            order.push(mm[1] ? +mm[1] : ++seq);
                            lits.push('');
                            last = mm.index + mm[0].length;
                        }
                        lits[lits.length - 1] += x.node.value.slice(last);
                        add(x.file, 'patterns', [key, lits, order]);
                    } else {
                        add(x.file, 'exact', [x.node.value, key]);
                        // 作者的 translate() 会去掉结尾的一个句点
                        if (/[^.]\.$/.test(x.node.value)) add(x.file, 'exact', [x.node.value.slice(0, -1), key]);
                    }
                    PH.lastIndex = 0;
                }
            }
            for (const v of out.values()) v.exact = v.exact.filter(Boolean);
            ctx.warn(`${dir || '(根目录)'}：识别到按语言分文件的翻译字典（${dicts.map(d => d.file.split('/').pop() + '=' + d.lang).join('、')}），合并 ${groups} 组${reused ? `；另有 ${reused} 组资源包 lang 里已有同名同内容的键，直接沿用` : ''}${vanilla ? `；${vanilla} 组是原版物品 / 生物名，改用游戏自带的翻译键` : ''}`);
        }
        return out;
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

        // ---- 调试输出：只在调试开关 / 调试标签 / 调试函数下执行的代码，文本不提取 ----
        const debugFile = DEBUG_FILE.test(file);
        const debugMemo = new Map();
        const mentionsDebug = (e) => {
            // 不进函数体：foo(() => {…debug…}).then(cb) 不算
            const stack = [e];
            while (stack.length) {
                const x = stack.pop();
                if (x.type === 'Literal' && typeof x.value === 'string' && DEBUG_STR.test(x.value)) return true;
                if (x.type === 'Identifier' && DEBUG_ID.test(x.name)) return true;
                if (/Function/.test(x.type)) continue;
                stack.push(...childrenOf(x));
            }
            return false;
        };
        const fnName = (f) => {
            if (f.id && f.id.name) return f.id.name;
            const q = f.parent;
            if (!q) return '';
            if (q.type === 'VariableDeclarator' && q.id.type === 'Identifier') return q.id.name;
            if ((q.type === 'Property' || q.type === 'MethodDefinition') && q.key) return q.key.name || q.key.value || '';
            if (q.type === 'AssignmentExpression') return q.left.type === 'Identifier' ? q.left.name : (propName(q.left) || '');
            return '';
        };
        const isNeg = (t) => t.type === 'UnaryExpression' && t.operator === '!';
        const isExit = (st) => {
            if (st && st.type === 'BlockStatement' && st.body.length === 1) st = st.body[0];
            return !!st && /^(ContinueStatement|ReturnStatement|BreakStatement)$/.test(st.type);
        };
        // 父节点 p 让子节点 c 处在调试分支里吗
        const debugEdge = (p, c) => {
            switch (p.type) {
                case 'IfStatement': case 'ConditionalExpression':
                    if (c === p.test || !mentionsDebug(p.test)) return false;
                    return c === p.consequent ? !isNeg(p.test) : isNeg(p.test);
                case 'LogicalExpression':
                    return p.operator === '&&' && c === p.right && !isNeg(p.left) && mentionsDebug(p.left);
                case 'ForOfStatement': case 'ForInStatement':
                    return c === p.body && mentionsDebug(p.right);
                case 'ForStatement': case 'WhileStatement': case 'DoWhileStatement':
                    return c === p.body && !!p.test && mentionsDebug(p.test);
                case 'CallExpression':
                    // world.getPlayers({tags:["debug"]}).forEach(p => …)、debugLog("…")
                    return c !== p.callee && mentionsDebug(p.callee);
                case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
                    return DEBUG_ID.test(fnName(p));
                case 'BlockStatement': case 'Program': case 'SwitchCase': {
                    // if (!player.hasTag("debug_x")) continue; 之后的语句
                    const list = p.type === 'SwitchCase' ? p.consequent : p.body;
                    const i = list.indexOf(c);
                    for (let j = 0; j < i; j++) {
                        const st = list[j];
                        if (st.type === 'IfStatement' && !st.alternate && isNeg(st.test) && isExit(st.consequent) && mentionsDebug(st.test)) return true;
                    }
                    return false;
                }
                default: return false;
            }
        };
        const inDebug = (node) => {
            if (debugFile) return true;
            const path = [];
            let c = node, res = false;
            while (c) {
                if (debugMemo.has(c)) { res = debugMemo.get(c); break; }
                path.push(c);
                const p = c.parent;
                if (!p) break;
                if (debugEdge(p, c)) { res = true; break; }
                c = p;
            }
            for (const x of path) debugMemo.set(x, res);
            return res;
        };
        let debugSkipped = 0;
        const skipDebug = (node) => { walk(node, (x) => { if (isStr(x) && !handled.has(x) && looksLikeText(x.value, 'loose')) debugSkipped++; handled.add(x); }); };

        // 选一个文件中没出现过的运行时变量名
        let RT = '__i18n';
        while (source.includes(RT)) RT += '_';

        // ---- 收集表单变量 / 表单类别名 ----
        // 作者自己写的同名包装类（RPG 的 systems/ui.js 导出 ActionFormData，内部再拼字符串调原生表单）不算原生表单：
        // 从本地文件导入的、文件里自己声明的同名类都排除，只认 @minecraft/server-ui
        const formClassNames = new Set(FORM_CLASSES);
        const formVars = new Set();
        const localNs = new Set();      // import * as f from "./functions.js"
        walk(ast, (n) => {
            if (n.type === 'ImportDeclaration') {
                const fromUi = n.source && n.source.value === '@minecraft/server-ui';
                for (const sp of n.specifiers) {
                    if (sp.type === 'ImportSpecifier') {
                        const im = sp.imported && (sp.imported.name || sp.imported.value);
                        if (!FORM_CLASSES.has(im)) continue;
                        if (fromUi) formClassNames.add(sp.local.name);
                        else formClassNames.delete(sp.local.name);
                    } else if (sp.type === 'ImportNamespaceSpecifier' && !fromUi) localNs.add(sp.local.name);
                }
            }
            if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id && FORM_CLASSES.has(n.id.name)) formClassNames.delete(n.id.name);
        });
        const isFormNew = (n) => n && n.type === 'NewExpression' &&
            ((n.callee.type === 'Identifier' && formClassNames.has(n.callee.name)) ||
             (n.callee.type === 'MemberExpression' && FORM_CLASSES.has(propName(n.callee)) && !(n.callee.object.type === 'Identifier' && localNs.has(n.callee.object.name))));
        // new ActionFormData().title(…) 这种链式调用的结果也是表单
        const chainIsFormNew = (e) => {
            for (let g = 0; g < 200 && e; g++) {
                if (isFormNew(e)) return true;
                if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression') e = e.callee.object;
                else if (e.type === 'ParenthesizedExpression') e = e.expression;
                else return false;
            }
            return false;
        };
        // this.form / this.#form（私有字段）
        const thisProp = (m) => m && m.type === 'MemberExpression' && !m.computed && m.property.type === 'PrivateIdentifier' ? '#' + m.property.name : propName(m);
        const formThisProps = new Set();   // this.form = new ActionFormData()
        walk(ast, (n) => {
            if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && chainIsFormNew(n.init)) formVars.add(n.id.name);
            if (n.type === 'AssignmentExpression' && chainIsFormNew(n.right)) {
                if (n.left.type === 'Identifier') formVars.add(n.left.name);
                else if (n.left.type === 'MemberExpression' && n.left.object.type === 'ThisExpression' && thisProp(n.left)) formThisProps.add(thisProp(n.left));
            }
        });
        const rootIsForm = (expr) => {
            let e = expr;
            for (let g = 0; g < 200 && e; g++) {
                if (e.type === 'MemberExpression' && e.object.type === 'ThisExpression' && formThisProps.has(thisProp(e))) return true;
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

        // 流进固定长度 ASCII HUD 数据包的文字（跨文件预扫描得到）：无法本地化，不提取；
        // 对照表里的一行（如 ['Sin companero', 'No partner']）有一项命中就整行跳过
        if (opts.asciiTexts && opts.asciiTexts.size) {
            const reported = new Set();
            const isPlain = (x) => !!x && (isStr(x) || (x.type === 'TemplateLiteral' && !x.expressions.length));
            const valOf = (x) => isStr(x) ? x.value : x.quasis[0].value.cooked;
            walk(ast, (n) => {
                if (!isPlain(n)) return;
                const from = opts.asciiTexts.get(valOf(n));
                if (!from) return;
                // 别的文件里只认对照表的一行（["Sin companero", "No partner"]），单独出现的同样文字可能用在聊天里
                const inRow = n.parent && n.parent.type === 'ArrayExpression' && n.parent.elements.length >= 2 && n.parent.elements.length <= 4 && n.parent.elements.every(isPlain);
                if (!from.has(file) && !inRow) return;
                const row = inRow ? n.parent.elements : [n];
                for (const e of row) {
                    handled.add(e);
                    const v = valOf(e);
                    if (!reported.has(v)) { reported.add(v); ctx.report(file, 'HUD 数据包字段', v, '固定长度 ASCII 的 HUD 字段：界面按字符位置截取，非 ASCII 字符会被替换，翻译键放不进去'); }
                }
            });
        }
        const warnedCollide = new Set();
        const src = source;

        // ---- 把 ID 拼成英文名的函数：(id) => id.split(":").pop().split("_").map(首字母大写).join(" ") ----
        // 文字在运行时才生成，没有可提取的原文；给返回值套上 H(id, 文字)，运行时按 ID 记下对应的翻译键
        // （原版用游戏自带键，包里自定义的物品 / 方块 / 实体用 item.<id>.name 等），之后显示时就能翻译
        let humanizers = 0;
        walk(ast, (n) => {
            if (!/Function/.test(n.type) || !n.params.length || n.params[0].type !== 'Identifier') return;
            const body = src.slice(n.body.start, n.body.end);
            if (body.length > 600 || !/\.split\(\s*(?:"_"|'_'|\/_\/g?)\s*\)/.test(body) || !/toUpperCase\(\)/.test(body) || !/\.join\(\s*(?:" "|' ')\s*\)/.test(body)) return;
            const pn = n.params[0].name;
            const wrap = (e) => { const prev = overrides.get(e); overrides.set(e, () => ` ${RT}.H(${pn}, (${prev ? prev() : renderOrig(e)}))`); };
            if (n.body.type !== 'BlockStatement') wrap(n.body);
            else walk(n.body, (r) => {
                if (r.type !== 'ReturnStatement' || !r.argument) return;
                let f = r.parent;
                while (f && !/Function/.test(f.type)) f = f.parent;
                if (f === n) wrap(r.argument);
            });
            humanizers++;
            usesRuntime = true;
        });
        if (humanizers) ctx.warn(`${file}: 发现 ${humanizers} 个把 ID 拼成英文名的函数，运行时按 ID 换成翻译键`);

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
        // 标记已静态改写的节点。模板 ${…} 里的表达式、拼接里的非字面量部分会原样保留（运行时 T() 翻译），
        // 其中的字符串（如 ${kit ? " Starter kit added." : ""}）仍要登记到运行时映射，所以不往里标记。
        const markHandled = (node) => {
            const skip = new Set();
            walk(node, (n) => {
                if (skip.has(n)) { walk(n, (x) => skip.add(x)); return; }
                handled.add(n);
                if (n.type === 'TemplateLiteral') n.expressions.forEach(e => { if (!isStr(e)) skip.add(e); });
                else if (n.type === 'BinaryExpression' && n.operator === '+')
                    [n.left, n.right].forEach(e => { if (!isStr(e) && e.type !== 'TemplateLiteral' && !(e.type === 'BinaryExpression' && e.operator === '+')) skip.add(e); });
            });
        };

        const wordy = (t) => /[A-Za-z]{2,}|[\u3040-\u30ff\u4e00-\u9fff]/.test(NS.stripFormatting(t)) && !looksLikeCommand(t);
        const meta = (hint) => ({ file, kind: 'script', scope: 'script', hint });
        const keyBase = (hint) => `script.${fb}.${hint}`;

        // `potion.${id}.splash.name`、`item.${ns}:${id}.name`：拼出来的是翻译键 / ID，不是文字
        const isKeyTemplate = (parts) => {
            const t = parts.map(p => ('lit' in p) ? p.lit : 'x').join('');
            if (/^[\w:-]+(\.[\w:-]+)+$/.test(t) || /^[a-z0-9_]+:[\w./-]+$/.test(t) || /^[\w-]+(\/[\w.-]+)+$/.test(t)) return true;
            // `@attributes.${id}.name: ${v}%`：去掉键名片段后没剩文字（只有标点、数字、占位）→ 是拼出来的引用，不是句子
            const rest = t.replace(/[@%]?[A-Za-z_][\w:-]*(\.[\w:-]+)+/g, ' ').replace(/\bx\b/g, ' ');
            return /[@%][A-Za-z_][\w:-]*\.[\w:-]/.test(t) && !/[A-Za-z]{2,}/.test(rest);
        };
        /** 片段 → rawtext 元素代码数组；返回 null 表示没有可翻译文本且无动态部分 */
        function buildElements(parts, hint) {
            const lines = ctx.splitNewlines ? splitLines(parts) : [parts];
            const els = [];
            let translated = false;
            lines.forEach((line, li) => {
                if (li > 0) els.push(JSON.stringify({ text: '\n' }));
                if (!line.length) return;
                const lit = litText(line);
                const dyn = line.some(p => !('lit' in p));
                if (dyn && isKeyTemplate(line)) { els.push(...line.map(p => ('lit' in p) ? JSON.stringify({ text: p.lit }) : `${RT}.T(${renderPart(p)})`)); usesRuntime = true; return; }
                if ((looksLikeText(lit, 'loose') || (dyn && wordy(lit))) && !(line.length === 1 && ctx.isKey(lit))) {
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
            if (inDebug(e)) { skipDebug(e); return; }   // p.sendMessage(DEBUG ? "…" : "…") 的调试分支
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
                else handled.add(e);   // 原样执行的命令字符串，不是显示文本
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
                if (spec && inDebug(n)) { n.arguments.forEach(skipDebug); return; }
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
                if (name && Object.prototype.hasOwnProperty.call(UNTRANSLATABLE_CALLS, name)) {
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
            if (inDebug(n)) { skipDebug(n.value); return; }
            for (const el of n.value.elements) {
                if (!el || el.type !== 'ObjectExpression' || el.properties.length !== 1) continue;
                const p = el.properties[0];
                if (p.type !== 'Property' || p.computed || (p.key.name || p.key.value) !== 'text') continue;
                if (!isStr(p.value)) {
                    // { text: message }：文字来自变量 / 表达式 → 运行时翻译（查不到时原样显示）
                    if (!injectRuntime || p.value.type === 'Literal' || handled.has(el) || overrides.has(el) || overrides.has(p.value)) continue;
                    usesRuntime = true;
                    overrides.set(el, () => `${RT}.T(${renderOrig(p.value)})`);
                    continue;
                }
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
        // 跨文件语言字典（en.js / es.js…）：预先合并好的键
        if (opts.crossDict) {
            for (const nd of opts.crossDict.nodes) handled.add(nd);
            exact.push(...opts.crossDict.exact);
            patterns.push(...opts.crossDict.patterns);
        }
        const tables = collectTranslationGroups(ast, { mode: lf.mode === 'manual' && !fileMap.size ? 'auto' : lf.mode, map: fileMap, fileHint: langHintFromFile(file) });
        let tableEntries = 0;
        // 原文优先用英文；没有英文时用拉丁字母语言（方便译者），最后才用其他文字
        const pickSource = (g) => {
            for (const l of ['en_US', 'en_GB']) if (g.has(l)) return [l, g.get(l)];
            const latin = [...g.entries()].find(([, nd]) => !/[^\u0000-\u024f\u1e00-\u1eff\s\p{P}\p{S}\p{N}]/u.test(nd.value));
            return latin || [...g.entries()][0];
        };
        for (const nd of tables.ignoredNodes || []) handled.add(nd);
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
            const srcEntry = pickSource(g);
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
            const [firstLang, firstNode] = pickSource(g);
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
                    if (typeof k === 'string' && TECH_PROPS.test(k)) return true;
                    // 后缀只管不带空格的值：语言表里 noMatchingTags: "§cThese blocks cannot be connected" 照常提取
                    if (typeof k === 'string' && (TECH_SUFFIX.test(k) || TECH_PROPS_WORD.test(k)) && isStr(node) && !/\s/.test(node.value.trim())) return true;
                    // { username: "Steve", printName: "§dSteve" }：玩家名单，同一对象里的文字都是名字
                    if (p.parent && p.parent.type === 'ObjectExpression' && p.parent.properties.some(x => x.type === 'Property' && !x.computed && /^(username|userName|playerName|gamertag|xuid)$/i.test(x.key.name || x.key.value || ''))) return true;
                    // 字段本身或外层对象的字段名是开发备注
                    for (let q = p, d = 0; q && d < 6; q = q.parent, d++) {
                        if (q.type === 'Property' && !q.computed) {
                            const qk = q.key.name || q.key.value;
                            if (typeof qk === 'string' && DEV_NOTE_KEY.test(qk)) return true;
                        } else if (q.type !== 'ObjectExpression' && q.type !== 'ArrayExpression') break;
                    }
                    return false;
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
            if (opts.refSyntax && (DICT_REF.lastIndex = 0, DICT_REF.test(text))) { DICT_REF.lastIndex = 0; registerPattern([{ lit: text }]); return; }
            const lines = ctx.splitNewlines ? text.split(/\r?\n/) : [text];
            for (const line of lines) {
                if (!looksLikeText(line, 'strict')) continue;
                if (ctx.isKey(line)) continue;
                // WaterGun、MeleeAttack 这种没有空格的驼峰词：代码里的标识符
                if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(line.trim())) continue;
                // 拆行时每行去掉代码缩进；原样和去空白后的写法都登记
                const multi = lines.length > 1 || fromSplit || line.indexOf('\n') >= 0;
                const t = (lines.length > 1 || fromSplit || !multi) ? line.trim() : line;
                const k = ctx.alloc(keyBase('str'), t, meta('str'));
                if (multi) { exact.push([line, k]); if (t !== line) exact.push([t, k]); }
                // 单行首尾空格（如 " Starter kit added."）：lang 里存去空格的文字，运行时找到后再把空格补回
                else exact.push([t, k]);
            }
        };
        // ${cond ? " only" : " · gate"}、或 const kind = cond ? … : …; `${where}${kind}`：
        // 分支全是字符串时展开成几种固定写法分别登记（译者看到完整句子，运行时也能整句匹配）
        const literalChoices = (e, depth = 0) => {
            if (!e || depth > 3) return null;
            if (isStr(e)) return [e.value];
            if (e.type === 'TemplateLiteral' && !e.expressions.length) return [e.quasis[0].value.cooked || ''];
            if (e.type === 'ConditionalExpression') {
                const a = literalChoices(e.consequent, depth + 1), b = literalChoices(e.alternate, depth + 1);
                return a && b ? [...a, ...b] : null;
            }
            if (e.type === 'Identifier' && depth === 0) {
                // 同一函数里 const x = 条件 ? "…" : "…"
                let fn = e.parent;
                while (fn && !/Function/.test(fn.type) && fn.type !== 'Program') fn = fn.parent;
                if (!fn) return null;
                let init = null, count = 0;
                walk(fn.body || fn, (d) => { if (d.type === 'VariableDeclarator' && d.id.type === 'Identifier' && d.id.name === e.name) { count++; init = d.init; } });
                if (count !== 1 || !init || init.type !== 'ConditionalExpression') return null;
                const c = literalChoices(init, depth + 1);
                if (c) for (const lit of (function f(x) { return x.type === 'ConditionalExpression' ? [...f(x.consequent), ...f(x.alternate)] : [x]; })(init)) handled.add(lit);
                return c;
            }
            return null;
        };
        const expandChoices = (parts) => {
            let variants = [[]];
            let expanded = false;
            for (const p of parts) {
                const ch = ('expr' in p) ? literalChoices(p.expr) : null;
                if (ch && ch.length <= 6 && variants.length * ch.length <= 12) {
                    expanded = true;
                    variants = variants.flatMap(v => [...new Set(ch)].map(c => [...v, { lit: c }]));
                } else variants = variants.map(v => [...v, p]);
            }
            if (!expanded) return null;
            // 合并相邻字面量
            return variants.map(v => v.reduce((acc, p) => {
                const last = acc[acc.length - 1];
                if ('lit' in p && last && 'lit' in last) last.lit += p.lit; else if (!('lit' in p) || p.lit) acc.push({ ...p });
                return acc;
            }, []));
        };

        const registerPattern = (parts, relaxed = false) => {
            if (isKeyTemplate(parts)) return;
            // 字典带 @引用 的包：代码里的 "@common.exp: §g" + n 这类拼接，引用部分当占位
            if (opts.refSyntax && !parts.refSplit) {
                const sp = splitDictRefs(parts);
                if (sp) {
                    sp.refSplit = true;
                    const lines = ctx.splitNewlines ? splitLines(sp) : [sp];
                    for (const line of lines) {
                        if (!line.length || !line.some(x => 'ref' in x)) { if (line.length) registerPattern(Object.assign(line, { refSplit: true }), relaxed); continue; }
                        const lits = [''];
                        for (const x of line) { if ('lit' in x) lits[lits.length - 1] += x.lit; else lits.push(''); }
                        if (lits.every(l => !l.trim())) continue;   // 只有引用和变量，没有自己的文字
                        const key = ctx.alloc(keyBase('fmt'), partsToValue(line), meta('fmt'));
                        patterns.push([key, lits]);
                    }
                    return;
                }
            }
            if (!relaxed) {
                const vs = expandChoices(parts);
                if (vs) {
                    if (!looksLikeText(litText(parts), 'loose') && !vs.some(v => looksLikeText(litText(v), 'loose'))) return;
                    for (const v of vs) {
                        if (!v.length) continue;
                        if (!v.some(p => !('lit' in p))) {
                            const t = litText(v).trim();
                            if (wordy(t) && !ctx.isKey(t) && !exact.some(([x]) => x === t)) exact.push([t, ctx.alloc(keyBase('str'), t, meta('str'))]);
                        } else registerPattern(v, true);
                    }
                    return;
                }
            }
            const lines = ctx.splitNewlines ? splitLines(parts) : [parts];
            for (const line of lines) {
                if (!line.length) continue;
                const hasExpr = line.some(p => !('lit' in p));
                if (!hasExpr) { registerExact(litText(line), lines.length > 1); continue; }
                if (relaxed ? !wordy(litText(line)) : !looksLikeText(litText(line), 'strict')) continue;
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

        // entit${n > 1 ? "ies" : "y"}：分支是粘在前一个单词上的词尾，不是独立文字
        const gluedSuffix = (q) => {
            const t = q.parent;
            if (t.type === 'TemplateLiteral') {
                const i = t.expressions.indexOf(q);
                return i >= 0 && /[A-Za-z]$/.test(t.quasis[i].value.cooked || '');
            }
            return isStr(t.left) && t.right === q && /[A-Za-z]$/.test(t.left.value);
        };
        const isPlusOperand = (n) => n.parent && n.parent.type === 'BinaryExpression' && n.parent.operator === '+';
        walk(ast, (n) => {
            if (handled.has(n)) return;
            if ((isStr(n) || n.type === 'TemplateLiteral' || (n.type === 'BinaryExpression' && n.operator === '+')) && inDebug(n)) {
                if (isStr(n) && looksLikeText(n.value, 'strict')) debugSkipped++;
                return;
            }
            if (isStr(n)) {
                if (isPlusOperand(n)) return;   // 属于某个拼接句式，由拼接根节点统一登记
                if (isTechPosition(n)) return;
                const v = n.value;
                if (looksLikeCommand(v)) { commandTexts(v).forEach(registerExact); return; }
                // 已改写的显示文本里 ${cond ? "mastered" : "complete"} 这种分支：单个小写词也是给玩家看的
                const q = n.parent;
                if (q && q.type === 'ConditionalExpression' && q.test !== n && q.parent && handled.has(q.parent)
                    && (q.parent.type === 'TemplateLiteral' || (q.parent.type === 'BinaryExpression' && q.parent.operator === '+'))
                    && /^[A-Za-z][A-Za-z' -]{1,40}$/.test(v) && !ctx.isKey(v) && !exact.some(([x]) => x === v)
                    && !gluedSuffix(q)) {
                    exact.push([v, ctx.alloc(keyBase('word'), v, meta('word'))]);
                    return;
                }
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

        const forceText = (v, hint = 'word') => {
            if (ctx.isKey(v) || exact.some(([x]) => x === v)) return;
            exact.push([v, ctx.alloc(keyBase(hint), v, meta(hint))]);
        };
        // 数据表里的名称列：{ mel: ["melee damage", "flat", 3, "added to every melee hit"], … }
        // 同一列全是互不相同的短词组、且表里另有一列是说明文字时，这列名称也是显示用的
        walk(ast, (n) => {
            if (n.type !== 'ObjectExpression' || n.properties.length < 3 || inDebug(n)) return;
            const rows = n.properties.map(p => p.value);
            if (!rows.every(r => r && r.type === 'ArrayExpression')) return;
            const len = rows[0].elements.length;
            if (len < 2 || !rows.every(r => r.elements.length === len)) return;
            const col = (i) => rows.map(r => r.elements[i]);
            const textCol = [...Array(len).keys()].some(i => { const c = col(i); return c.filter(e => isStr(e) && looksLikeText(e.value, 'loose')).length >= c.length * 0.5; });
            if (!textCol) return;
            for (let i = 0; i < len; i++) {
                const c = col(i);
                if (!c.every(e => isStr(e) && !handled.has(e) && /^[A-Za-z][A-Za-z '\-]{1,40}$/.test(e.value))) continue;
                if (new Set(c.map(e => e.value)).size < c.length * 0.8) continue;   // 单位、类型这类重复值的列不是名称
                for (const e of c) { forceText(e.value); handled.add(e); }
            }
        });
        // names.join("§7 or §f")：带文字的分隔符登记翻译，运行时据此拆分列表
        const joinSeps = [];
        walk(ast, (n) => {
            if (n.type !== 'CallExpression' || propName(n.callee) !== 'join' || n.arguments.length !== 1 || !isStr(n.arguments[0])) return;
            const v = n.arguments[0].value, core = NS.stripFormatting(v).trim();
            if (!/^[A-Za-z][A-Za-z ]{0,15}$/.test(core) || core.length < 2) return;
            forceText(core);
            handled.add(n.arguments[0]);
            if (!joinSeps.includes(v)) joinSeps.push(v);
        });
        // 大写常量里的显示用标签：const FLAT = "§8[flat]";
        walk(ast, (n) => {
            if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || !/^[A-Z][A-Z0-9_]+$/.test(n.id.name) || !isStr(n.init) || inDebug(n)) return;
            const v = n.init.value, plain = NS.stripFormatting(v).trim();
            if (!/[A-Za-z]{2,}/.test(plain) || plain.length > 40 || /^[\w.:\/-]+$/.test(plain) || looksLikeCommand(v) || ctx.isKey(v)) return;
            if (!/\u00a7|[\[\](){}<>]/.test(v)) return;
            forceText(plain);
            handled.add(n.init);
        });

        // 跨文件预扫描得到的参数文字（如默认值 'item'、调用处传入的 'block'）
        for (const t of opts.paramTexts || []) {
            if (ctx.isKey(t) || exact.some(([x]) => x === t)) continue;
            exact.push([t, ctx.alloc(keyBase('word'), t, meta('word'))]);
        }

        if (debugSkipped) ctx.warn(`${file}: ${debugFile ? '调试脚本' : '调试分支'}里的 ${debugSkipped} 处文本未提取`);

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
                prelude += `${RT}.reg(${JSON.stringify(ex)}, ${JSON.stringify(patterns)}${joinSeps.length ? ', ' + JSON.stringify(joinSeps) : ''});\n`;
            }
            if (humanizers) {
                // ID → 翻译键：包里自定义的 + 原版
                const own = {};
                if (opts.idKeys) for (const [id, k] of opts.idKeys()) own[id] = k;
                const V = NS.VANILLA || { ids: {}, ents: {} };
                prelude += `${RT}.regIds(${JSON.stringify(Object.assign({}, V.ids, own))}, ${JSON.stringify(V.ents)});\n`;
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

    /**
     * 已转换脚本：把注入的运行时换成当前版本（修复旧运行时的问题），登记的文字和改写过的代码不动。
     * 返回新内容；不是转换过的脚本或已是最新时返回 null。
     */
    function upgradeRuntime(txt) {
        const START = '// ---- i18n runtime (auto-generated) ----\n';
        const i = txt.indexOf(START);
        if (i < 0) return null;
        const from = i + START.length;
        const head = /^const ([A-Za-z_$][\w$]*) = \(\(\) => \{\n  const g = globalThis, K = ("(?:[^"\\]|\\.)*");/.exec(txt.slice(from, from + 400));
        if (!head) return null;
        const rt = head[1];
        let key;
        try { key = JSON.parse(head[2]); } catch (e) { return null; }
        const endMark = txt.indexOf('// ---- end i18n runtime ----', from);
        if (endMark < 0) return null;
        let to = txt.indexOf(`\n${rt}.reg(`, from);
        const to2 = txt.indexOf(`\n${rt}.regIds(`, from);
        if (to2 >= 0 && to2 < endMark && (to < 0 || to2 < to)) to = to2;
        to = to >= 0 && to < endMark ? to + 1 : endMark;
        const fresh = buildRuntime(rt, key);
        if (txt.slice(from, to) === fresh) return null;
        return txt.slice(0, from) + fresh + txt.slice(to);
    }
    NS.upgradeRuntime = upgradeRuntime;
    NS.collectScriptInfo = collectScriptInfo;
    NS.guessLang = guessLang;
    NS.regexPhrases = regexPhrases;
    NS.langHintFromFile = langHintFromFile;
    NS.collectTranslationGroups = collectTranslationGroups;
    NS.processScript = processScript;
    NS.collectParamTexts = collectParamTexts;
    NS.collectAsciiPacketTexts = collectAsciiPacketTexts;
    NS.collectCrossFileDicts = collectCrossFileDicts;
    NS.SCRIPT_SINKS = SINKS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
