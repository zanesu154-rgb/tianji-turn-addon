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
        'Symbol', 'parseInt', 'parseFloat', 'Number', 'Date', 'setItem', 'getItem', 'querySelector',
    ]);

    // 这些属性名对应的值是技术数据
    const TECH_PROPS = /^(id|typeId|identifier|type|icon|iconPath|texture|image|path|sound|event|tag|tags|objective|permission|defaultValue|key|namespace|entity|item|block|dimension|mode|command|cmd|url|uuid|color|font)$/i;

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
  const one = (s) => {
    let k = m.get(s);
    if (k) return [{ translate: k }];
    const mm = /^((?:\\u00a7.|\\s)*)([\\s\\S]*?)((?:\\u00a7.|\\s)*)$/.exec(s);
    if (mm && mm[2] !== s && (k = m.get(mm[2]))) {
      const r = [{ translate: k }];
      if (mm[1]) r.unshift({ text: mm[1] });
      if (mm[3]) r.push({ text: mm[3] });
      return r;
    }
    for (const [pk, re] of p) {
      const x = re.exec(s);
      if (x) return [{ translate: pk, with: { rawtext: x.slice(1).map(T) } }];
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
    for (const [s, k] of exact) if (!m.has(s)) m.set(s, k);
    for (const [k, lits] of pats) {
      const len = lits.join("").length;
      p.push([k, new RegExp("^" + lits.map(esc).join("([\\\\s\\\\S]*?)") + "$"), len]);
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

        // ---- 第三遍：登记其余“像玩家文本”的字符串到运行时映射 ----
        const isTechPosition = (node) => {
            const p = node.parent;
            if (!p) return false;
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

        const registerExact = (text) => {
            const lines = ctx.splitNewlines ? text.split(/\r?\n/) : [text];
            for (const line of lines) {
                if (!looksLikeText(line, 'strict')) continue;
                if (ctx.isKey(line)) continue;
                exact.push([line, ctx.alloc(keyBase('str'), line, meta('str'))]);
            }
        };
        const registerPattern = (parts) => {
            const lines = ctx.splitNewlines ? splitLines(parts) : [parts];
            for (const line of lines) {
                if (!line.length) continue;
                const hasExpr = line.some(p => !('lit' in p));
                if (!hasExpr) { registerExact(litText(line)); continue; }
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
                if (looksLikeCommand(parts.find(p => 'lit' in p).lit)) return;
                registerPattern(parts);
            }
        });

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
        return { content, changed: true, stats: { overrides: overrides.size, exact: exact.length, patterns: patterns.length } };
    }

    NS.collectScriptInfo = collectScriptInfo;
    NS.processScript = processScript;
    NS.SCRIPT_SINKS = SINKS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
