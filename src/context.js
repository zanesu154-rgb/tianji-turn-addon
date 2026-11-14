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

    /**
     * 多行模板字符串常带有代码缩进（第二行起整体缩进 ≥4 个空格），
     * 写进 lang 前去掉这部分缩进和行尾空白，译者看到的是干净的文本。
     */
    function dedentCode(text) {
        if (typeof text !== 'string' || text.indexOf('\n') < 0) return text;
        const lines = text.split('\n');
        const rest = lines.slice(1).filter(l => l.trim());
        if (!rest.length) return text;
        const ind = Math.min(...rest.map(l => /^[ \t]*/.exec(l)[0].length));
        if (ind < 4) return text;
        return lines.map((l, i) => (i ? l.slice(Math.min(ind, /^[ \t]*/.exec(l)[0].length)) : l).replace(/[ \t]+$/, '')).join('\n');
    }
    NS.dedentCode = dedentCode;

    // 认领上次的键时用来核对“这条译文是不是这句原文的”：占位符、格式代码、换行、数字要一致，长度大致相当
    function seriesFeat(s) {
        s = String(s).replace(/\\n/g, '\n');
        const plain = (NS.stripFormatting ? NS.stripFormatting(s) : s.replace(/§./g, '')).replace(/%\d+\$[sd]|%[sd]/g, '').replace(/\s+/g, '');
        return {
            ph: (s.match(/%\d+\$[sd]|%[sd]/g) || []).length,
            nl: (s.match(/\n/g) || []).length,
            codes: (s.replace(/(?:§r|\s)+$/i, '').match(/§[0-9a-v]/gi) || []).map(c => c.toLowerCase()).sort().join(''),
            nums: (s.replace(/%\d+\$[sd]/g, '').match(/\d+/g) || []).sort().join(','),
            len: plain.length,
            cjk: NS.hasCJK(s),
        };
    }
    function seriesCompat(a, b, loose) {
        if (a.ph !== b.ph || a.nl !== b.nl || a.codes !== b.codes || (!loose && a.nums !== b.nums)) return false;
        if (!a.len || !b.len) return a.len === b.len;
        const r = b.len / a.len;
        if (a.cjk === b.cjk) return r >= 0.4 && r <= 2.5;
        return a.cjk ? r >= 0.8 && r <= 10 : r >= 0.1 && r <= 1.2;
    }

    /**
     * 只放回译文 lang 时，把这次按顺序分配的原文和上次的键整体对齐（类似 diff）：
     * 占位符 / 换行 / 格式代码对不上的不能配；数字、长度比例越像得分越高；中间可以有新增或删掉的条目。
     * @returns Map(基础键 → Map(序号 → 键))
     */
    function alignSeries(ctx) {
        const plan = new Map();
        if (!ctx.seriesLog || !ctx._seriesIdx) return plan;
        const vals = (k) => { const e = ctx.existingValues.get(k); return e instanceof Set ? [...e] : e != null ? [e] : []; };
        for (const [base, seq] of ctx.seriesLog) {
            const exactKeys = new Set(seq.map(x => x.exact).filter(Boolean));
            const olds = (ctx._seriesIdx.get(base) || []).filter(([, k]) => !exactKeys.has(k) && !ctx.referenced.has(k)).map(([i, k]) => {
                const langs = [...(ctx.keyLangs.get(k) || [])];
                // 有原文这一侧语言的旧键：只有上次本工具生成的（原文改过了）才能认领
                return { i, k, v: vals(k), f: vals(k).map(seriesFeat), en: ctx.prevKeys.has(k) || !langs.some(l => /^en_/.test(l)), cjk: ctx.prevKeys.has(k) || !langs.some(l => /^(zh|ja|ko)_/.test(l)) };
            });
            // 序号远远跳开的旧键（中间空了几百号）多半是早就不用的旧条目，不参与认领
            for (let t = 1; t < olds.length; t++) if (olds[t].i - olds[t - 1].i > 200) { olds.length = t; break; }
            const news = seq.filter(x => !x.exact).map(x => ({ j: x.j, text: x.text, f: seriesFeat(x.text) }));
            if (!olds.length || !news.length) continue;
            const score = (a, bs) => {
                let best = -1;
                for (const b of bs) {
                    if (a.ph !== b.ph || a.nl !== b.nl || a.codes !== b.codes) continue;
                    let sc = 3 + (a.ph + a.nl + a.codes.length / 2) * 0.5 + (a.nums && a.nums === b.nums ? 1.5 : a.nums !== b.nums ? -0.6 : 0);
                    if (a.len && b.len) {
                        const r0 = a.cjk === b.cjk ? 1 : a.cjk ? 2.6 : 0.38;
                        sc += Math.max(-1, 1 - Math.abs(Math.log((b.len / a.len) / r0)) * 1.2);
                    }
                    if (sc > best) best = sc;
                }
                return best;
            };
            const N = news.length, M = olds.length;
            const band = Math.max(150, Math.abs(N - M) + 150);
            const W = 2 * band + 1;
            const center = (n) => Math.round(n * M / N);
            const at = (n, m) => { const d = m - center(n) + band; return d >= 0 && d < W ? n * W + d : -1; };
            const NEG = -1e9;
            // 带状 DP（类似 diff）：配对得分最高的对齐方式；返回 [新序号, 旧序号] 列表
            const runDP = (pairScore) => {
                const dp = new Float64Array((N + 1) * W).fill(NEG);
                const tb = new Uint8Array((N + 1) * W);   // 1 = 配对, 2 = 跳过新原文, 3 = 跳过旧键
                dp[at(0, 0)] = 0;
                for (let m = 1; m <= Math.min(M, band); m++) { const x = at(0, m); if (x >= 0) { dp[x] = 0; tb[x] = 3; } }
                for (let n = 1; n <= N; n++) {
                    const c = center(n);
                    for (let m = Math.max(0, c - band); m <= Math.min(M, c + band); m++) {
                        const x = at(n, m);
                        let best = NEG, how = 0;
                        const up = at(n - 1, m);
                        if (up >= 0 && dp[up] > best) { best = dp[up]; how = 2; }
                        if (m > 0) {
                            const left = at(n, m - 1);
                            if (left >= 0 && dp[left] > best) { best = dp[left]; how = 3; }
                            const diag = at(n - 1, m - 1);
                            if (diag >= 0 && dp[diag] > NEG / 2) {
                                const sc = pairScore(n - 1, m - 1);
                                if (sc > 0 && dp[diag] + sc > best) { best = dp[diag] + sc; how = 1; }
                            }
                        }
                        dp[x] = best; tb[x] = how;
                    }
                }
                let n = N, m = -1, bestEnd = NEG;
                for (let mm = Math.max(0, center(N) - band); mm <= Math.min(M, center(N) + band); mm++) { const x = at(N, mm); if (x >= 0 && dp[x] > bestEnd) { bestEnd = dp[x]; m = mm; } }
                const out = [];
                while (n > 0 && m >= 0) {
                    const x = at(n, m);
                    if (x < 0) break;
                    const how = tb[x];
                    if (how === 1) { out.push([n - 1, m - 1]); n--; m--; }
                    else if (how === 2) n--;
                    else if (how === 3) m--;
                    else break;
                }
                return out;
            };
            const baseScore = (n, m) => { const o = olds[m], a = news[n].f; return (a.cjk ? o.cjk : o.en) ? score(a, o.f) : -1; };
            let pairs = runDP(baseScore);
            // 第二遍：从第一遍的配对里学“哪个词常对应哪个译词”（Banner ↔ 旗帜、Statue ↔ 雕像），
            // 把它加进得分再对齐一次，纯文字的长串里也能对准
            if (pairs.length >= 40) {
                const toks = (s, cjk) => {
                    const t = (NS.stripFormatting ? NS.stripFormatting(String(s)) : String(s)).replace(/\\n|%\d+\$s/g, ' ');
                    if (cjk) { const out = new Set(); const run = t.match(/[぀-ヿ㐀-鿿가-힯]+/g) || []; for (const r of run) { if (r.length === 1) out.add(r); for (let i = 0; i + 1 < r.length; i++) out.add(r.slice(i, i + 2)); } return out; }
                    return new Set((t.toLowerCase().match(/[a-zÀ-ɏ]{3,}/g) || []));
                };
                const nT = news.map(x => toks(x.text, x.f.cjk));
                const oT = olds.map(o => { const s = new Set(); for (const v of o.v) for (const t of toks(v, NS.hasCJK(v))) s.add(t); return s; });
                const cw = new Map(), ct = new Map(), cwt = new Map();
                const inc = (mp, k) => mp.set(k, (mp.get(k) || 0) + 1);
                for (const [n, m] of pairs) {
                    for (const w of nT[n]) inc(cw, w);
                    for (const t of oT[m]) inc(ct, t);
                    for (const w of nT[n]) for (const t of oT[m]) inc(cwt, w + '\u0000' + t);
                }
                const assoc = (w, t) => { const c = cwt.get(w + '\u0000' + t) || 0; return c < 2 ? 0 : c / Math.sqrt(cw.get(w) * ct.get(t)); };
                const lex = (n, m) => {
                    let sum = 0, cnt = 0;
                    for (const w of nT[n]) {
                        if ((cw.get(w) || 0) < 2) continue;
                        cnt++;
                        let best = 0;
                        for (const t of oT[m]) { const v = assoc(w, t); if (v > best) best = v; }
                        sum += best;
                    }
                    return cnt ? sum / cnt : null;
                };
                pairs = runDP((n, m) => {
                    const sc = baseScore(n, m);
                    if (sc <= 0) return sc;
                    const l = lex(n, m);
                    return l == null ? sc : sc + (l - 0.25) * 6;
                });
            }
            const map = new Map();
            for (const [n, m] of pairs) map.set(news[n].j, olds[m].k);
            if (map.size) plan.set(base, map);
        }
        return plan;
    }
    NS.alignSeries = alignSeries;

    class ExtractContext {
        constructor(options = {}) {
            this.knownKeys = options.knownKeys || new Set();         // 附加包中已有的所有 lang 键
            this.existingValues = options.existingValues || new Map(); // 源语言 lang 中已有的 键→值
            this.keyLangs = options.keyLangs || new Map();           // 键 → Set(有这个键的语言)
            this.prevKeys = options.prevKeys || new Set();           // 上次转换写进 lang 的键（标记行之后）
            this.claimed = new Set();      // 本次转换已认领的已有键（上次转换生成的）
            this.nameAliases = new Map();    // 同一个名称的另一种写法的键（item.x / item.x.name / 大小写不同）→ 沿用的键
            this.sourceOverride = new Map();
            this.alignPlan = options.alignPlan || null;   // 基础键 → (序号 → 上次的键)
            this.seriesLog = options.recordSeries ? new Map() : null;
            this.tagStrip = new Map();       // 键 → 旧译文开头要去掉的界面标识（"dingUI:quota_blue§z"） // 键 → { value: 新原文, olds: [旧原文] }：沿用默认名称键并更新原文
            this.reusedPrev = 0;
            this.splitNewlines = options.splitNewlines !== false;
            this.entries = new Map();      // 新键 → { value, file, kind }
            this.keyFiles = new Map();     // 键 → Set(用到它的文件)
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
        alloc(baseKey, text, opts = {}) {
            const key = this._alloc(baseKey, text, opts);
            // 记录每个键被哪些文件用到（多个包放在一起时，按文件所在的包分别写 lang）
            if (opts.file) {
                if (!this.keyFiles.has(key)) this.keyFiles.set(key, new Set());
                this.keyFiles.get(key).add(opts.file);
            }
            return key;
        }

        _alloc(baseKey, text, { file = '', kind = '', scope = null } = {}) {
            text = dedentCode(text);
            const base = sanitizeKey(baseKey);
            if (scope) {
                const d = this.dedupe.get(scope + '\u0000' + text);
                if (d) return d;
            }
            let key;
            // 脚本里的文字正好是某个物品 / 方块 / 实体的现成名称（音乐唱片名、物品名）：直接用那个名称键，不另建一条
            const npcName = kind === 'dialogue' && /\.npc_name$/.test(base);
            if ((/^(script|item|block|entity|ui)$/.test(kind) || npcName) && !this.entries.has(base)) {
                if (!this._nameIdx) {
                    this._nameIdx = new Map();
                    for (const [k, ev] of this.existingValues) {
                        if (!/^(item|tile|entity)\.[^.]+(\.name)?(\.short)?$/.test(k)) continue;
                        for (const v of (ev instanceof Set ? ev : [ev])) {
                            if (typeof v !== 'string') continue;
                            // 也按去掉首尾颜色码的写法登记（显示位置会把开头的 §b 拆出去）
                            for (const x of new Set([v, v.replace(/^(?:\u00a7.)+|(?:\u00a7.)+$/g, '')])) { if (!x) continue; if (!this._nameIdx.has(x)) this._nameIdx.set(x, []); this._nameIdx.get(x).push(k); }
                        }
                    }
                }
                const ks = this._nameIdx.get(text) || [];
                // 脚本：任何现成名称都可以；NPC 名字：实体名；物品 / 方块 / 实体：只用同一个 ID 的（大小写不同、带不带 .name）
                const idOf = (k) => k.replace(/^(item|tile|entity)\./, '').replace(/\.name$/, '').toLowerCase();
                const nk = kind === 'script' || kind === 'ui' ? ks[0] : npcName ? ks.find(k => k.startsWith('entity.')) : ks.find(k => idOf(k) === idOf(base));
                if (nk) { if (scope) this.dedupe.set(scope + '\u0000' + text, nk); return nk; }
            }
            // 物品 / 方块 / 实体自己的默认名称键（item.x.name、tile.x.name）已在 lang 里、但 display_name 写的是另一段文字：
            // display_name 会盖过 lang 里那条，它已经没用了 → 直接沿用这个键，把原文更新成 display_name 的文字（不另建 _1）
            // lang 里的同一个名称键（大小写不同、没带 .name 的写法也算）
            let own = null;
            if (/^(item|block|entity)$/.test(kind) && /^(item|tile|entity)\.[^.]+\.name$/.test(base) && base.indexOf(':') > 0) {
                if (this.knownKeys.has(base)) own = base;
                else {
                    const want = new Set([base.toLowerCase(), base.replace(/\.name$/, '').toLowerCase()]);
                    if (!this._lowerKeys) { this._lowerKeys = new Map(); for (const k of this.knownKeys) { const l = k.toLowerCase(); if (!this._lowerKeys.has(l)) this._lowerKeys.set(l, []); this._lowerKeys.get(l).push(k); } }
                    for (const w of want) if (this._lowerKeys.has(w)) { own = this._lowerKeys.get(w)[0]; break; }
                }
                if (own) {
                    // 同一个名称的其他写法（item.x 和 item.x.name 同时存在、大小写不同）：写 lang 时并进沿用的键，不再输出两遍
                    if (!this._lowerKeys) { this._lowerKeys = new Map(); for (const k of this.knownKeys) { const l = k.toLowerCase(); if (!this._lowerKeys.has(l)) this._lowerKeys.set(l, []); this._lowerKeys.get(l).push(k); } }
                    for (const w of [base.toLowerCase(), base.replace(/\.name$/, '').toLowerCase()]) for (const k of this._lowerKeys.get(w) || []) if (k !== own && !this.nameAliases.has(k)) this.nameAliases.set(k, own);
                }
            }
            if (own && !this.entries.has(own) && !this.claimed.has(own) && !this.referenced.has(own)) {
                const base0 = base;
                const olds = [];
                for (const k of [own, ...[...this.nameAliases].filter(([, o]) => o === own).map(([a]) => a)]) {
                    const ev = this.existingValues.get(k);
                    for (const v of ev instanceof Set ? ev : ev != null ? [ev] : []) if (!olds.includes(v)) olds.push(v);
                }
                // 只有旧值和新文字是同一种文字（都是英文 / 都是中文）才算过时的原文；不同文字是译文，交给下面的逻辑
                if (olds.includes(text) && own !== base0) { this.claimed.add(own); if (scope) this.dedupe.set(scope + '\u0000' + text, own); return own; }
                if (!olds.includes(text) && olds.some(o => NS.hasCJK(o) === NS.hasCJK(text))) {
                    // 旧原文只算和新文字同一种文字的（另一种文字的是译文，要保留）
                    this.sourceOverride.set(own, { value: text, olds: olds.filter(o => NS.hasCJK(o) === NS.hasCJK(text)) });
                    this.entries.set(own, { value: text, file, kind });
                    this.claimed.add(own);
                    if (scope) this.dedupe.set(scope + '\u0000' + text, own);
                    return own;
                }
            }
            // 上次转换生成的同系列键（base、base_1、base_2……，中间可能有被删掉的空号）：
            // 1) 原文相同（把上次输出的 en_US.lang 一起放回来）→ 直接复用
            // 2) 只有译文、没有原文这一侧的语言（只放回了翻译好的 zh_CN.lang）→ 按顺序认领。
            //    新版本可能多提取或少提取了几条，序号会整体错开：认领前核对占位符、格式代码、换行、数字和长度，
            //    对不上的不认；有特征的条目（占位符、格式代码、数字……）对上后据此校正错开的位数
            if (!this._seriesIdx) {
                this._seriesIdx = new Map();
                const put = (b, i, k) => { if (!this._seriesIdx.has(b)) this._seriesIdx.set(b, []); this._seriesIdx.get(b).push([i, k]); };
                for (const k of this.knownKeys) {
                    put(k, 0, k);
                    const m = /^(.+)_([1-9]\d*)$/.exec(k);
                    if (m) put(m[1], +m[2], k);
                }
                for (const v of this._seriesIdx.values()) v.sort((a, b) => a[0] - b[0]);
            }
            const seriesI = this._seriesIdx.get(base) || [];
            const series = seriesI.map(x => x[1]);
            if (series.length > 1 || (series.length === 1 && this.keyLangs.size)) {
                const free = (k) => !this.claimed.has(k) && !this.entries.has(k) && !this.referenced.has(k);
                let hit = series.find(k => free(k) && (() => { const e = this.existingValues.get(k); return e instanceof Set ? e.has(text) : e === text; })());
                if (!this._seriesState) this._seriesState = new Map();
                if (!this._seriesState.has(base)) this._seriesState.set(base, { ord: 0, off: 0 });
                const st = this._seriesState.get(base), j = st.ord++;
                if (this.seriesLog) { if (!this.seriesLog.has(base)) this.seriesLog.set(base, []); this.seriesLog.get(base).push({ j, text, exact: hit || null }); }
                const planned = this.alignPlan && this.alignPlan.get(base);
                if (!hit && planned) {
                    // 预演后整体对齐得到的认领方案（见 alignSeries）
                    const k = planned.get(j);
                    if (k && free(k)) {
                        this.claimed.add(k);
                        this.reusedPrev++;
                        this.entries.set(k, { value: text, file, kind });
                        if (scope) this.dedupe.set(scope + '\u0000' + text, k);
                        return k;
                    }
                } else if (!hit && this.keyLangs.size) {
                    const cjk = NS.hasCJK(text);
                    const sideOf = (l) => cjk ? /^(zh|ja|ko)_/.test(l) : /^en_/.test(l);
                    const a = seriesFeat(text);
                    const strong = a.ph + a.nl + a.codes.length / 2 + (a.nums ? 1 : 0) > 0;
                    const vals = (k) => { const e = this.existingValues.get(k); return e instanceof Set ? [...e] : e != null ? [e] : []; };
                    const e = j + st.off;
                    // 数字只在“换了位置去找”时严格核对；正好在原位置上的，译文写法不同（2k / 2000）也认
                    const cands = seriesI.filter(([i, k]) => free(k) && (this.prevKeys.has(k) || ![...(this.keyLangs.get(k) || [])].some(sideOf))
                        && vals(k).some(v => seriesCompat(a, seriesFeat(v), i === e)));
                    let best = null;
                    for (const c of cands) if (!best || Math.abs(c[0] - e) < Math.abs(best[0] - e)) best = c;
                    if (best && (strong ? Math.abs(best[0] - e) <= 80 : best[0] === e)) {
                        hit = best[1];
                        if (strong) st.off = best[0] - j;
                        this.claimed.add(hit);
                        this.reusedPrev++;
                        this.entries.set(hit, { value: text, file, kind });
                        if (scope) this.dedupe.set(scope + '\u0000' + text, hit);
                        return hit;
                    }
                    hit = null;
                }
                if (hit) {
                    this.claimed.add(hit);
                    if (scope) this.dedupe.set(scope + '\u0000' + text, hit);
                    return hit;
                }
            }
            // 附加包里已有这个键且值相同 → 直接复用
            const ev = this.existingValues.get(base);
            const evList = ev instanceof Set ? [...ev] : (ev != null ? [ev] : []);
            if (evList.includes(text)) {
                key = base;
            } else if (evList.length && evList.every(v => NS.hasCJK(v) !== NS.hasCJK(text)) && !this.entries.has(base) && !this.referenced.has(base)
                && evList.some(v => seriesCompat(seriesFeat(text), seriesFeat(v), true))) {
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
            if (typeof key === 'string') key = key.replace(/^%(?=[^%\s])/, '');   // "%tile.x.name" 引用的是 tile.x.name
            if (typeof key === 'string' && !this.referenced.has(key)) this.referenced.set(key, file);
        }

        report(file, where, text, reason) {
            if (isEmptyText(text)) return;
            // 只有格式码（§u）、数字、技术 ID、已有翻译键的不是给玩家看的文字，不列入报告
            if (!NS.looksLikeText(text) || this.isKey(text)) return;
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
            // 基岩版里 "%键名" 表示“按此键翻译”（如 "%tile.mod.block.name"），同样视为已有键
            if (typeof s === 'string' && /^\s*%[A-Za-z]/.test(s) && isLikelyKey(s.trim().slice(1), this.knownKeys)) return true;
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
            // 以前整段（连同界面标识）写进 lang 的：沿用那个键，各语言值里开头的标识去掉，译文保留
            const allocT = (value) => {
                if (tagged) {
                    const full = tagged + value;
                    for (const [k, ev] of this.existingValues) {
                        if (!(ev instanceof Set ? ev.has(full) : ev === full)) continue;
                        if (this.entries.has(k) || this.claimed.has(k) || this.referenced.has(k)) continue;
                        this.claimed.add(k);
                        this.entries.set(k, { value, file: meta.file, kind: meta.kind });
                        if (meta.scope) this.dedupe.set(meta.scope + '\u0000' + value, k);
                        this.tagStrip.set(k, tagged);
                        return k;
                    }
                }
                return this.alloc(baseKey, value, meta);
            };
            const m = /^((?:§.|\s)*)([\s\S]*?)((?:§.|\s)*)$/.exec(text);
            let lead = m[1], body = m[2];
            const tail = m[3];
            // 开头是给自定义界面认的内部标识（"dingUI:quota_blue§z剩余天数…"）：原样保留在译文外，只翻后面的文字
            const tag = /^([A-Za-z_][\w-]*(?::[\w.\/-]+|_[\w.\/-]*)(?:§.)+)(?=[\s\S])/.exec(body);
            let tagged = null;
            if (tag && textOk(body.slice(tag[1].length).replace(SENTINEL_RE, ' '))) { lead += tag[1]; body = body.slice(tag[1].length); tagged = tag[1]; }
            if (lead) nodes.push({ text: lead });

            if (hasSentinel) {
                const args = [];
                let n = 0;
                const value = NS.pctArgs(body).replace(SENTINEL_RE, (s) => {
                    args.push({ text: s });
                    return `%${++n}$s`;
                });
                const key = allocT(value);
                nodes.push({ translate: key, with: { rawtext: args } });
            } else {
                const lines = this.splitNewlines && !meta.noSplit ? body.split(/\r?\n/) : [body];
                lines.forEach((line, i) => {
                    if (i > 0) nodes.push({ text: '\n' });
                    if (!line) return;
                    if (textOk(line)) {
                        nodes.push({ translate: lines.length === 1 ? allocT(line) : this.alloc(baseKey, line, meta) });
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
            // 先登记这条消息里已经在用的键（旧版转换过的 tellraw 里 {"translate":"world.command.x"}），
            // 免得给同一条里的其他文字分配键时把它当成“上次生成、可以认领”的键
            if (!meta._scanned) {
                const walkRefs = (o) => { if (!o || typeof o !== 'object') return; if (typeof o.translate === 'string') this.ref(o.translate, meta.file); for (const v of Array.isArray(o) ? o : Object.values(o)) walkRefs(v); };
                walkRefs(msg);
                meta = { ...meta, _scanned: true };
            }
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
