/* ================================================================
 *  world/editor.js —— 存档 NBT 编辑器（界面）
 *    需人工翻译：游戏不支持翻译键的文本，逐条原位修改；导出 / 导入翻译表批量处理
 *    搜索：按键名或内容查找，结果可直接编辑
 *    浏览：方块实体 / 实体 / level.dat 的完整树，展开时才渲染
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;
    const { T } = NS.NBT;
    const L = (...a) => (NS.UI ? NS.UI.t(...a) : a[0]);   // 界面文字（t 在本文件里是 NBT 类型）
    const TYPE_NAME = { 1: 'byte', 2: 'short', 3: 'int', 4: 'long', 5: 'float', 6: 'double', 7: 'byte[]', 8: 'string', 9: 'list', 10: 'compound', 11: 'int[]', 12: 'long[]' };
    const EDITABLE = new Set([T.BYTE, T.SHORT, T.INT, T.LONG, T.FLOAT, T.DOUBLE, T.STRING]);
    const PAGE = 200;

    function el(tag, attrs = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of kids) if (c != null) e.append(c);
        return e;
    }

    /**
     * 可编辑的值：字符串用多行文本框，数字用输入框；失焦或回车提交
     */
    function valueEditor(session, ref, t, value, onChange, orig) {
        const isStr = t === T.STRING;
        const input = isStr
            ? el('textarea', { class: 'nbt-input', rows: Math.min(6, Math.max(1, String(value).split('\n').length)), spellcheck: 'false' })
            : el('input', { class: 'nbt-input nbt-num', type: 'text', inputmode: t === T.FLOAT || t === T.DOUBLE ? 'decimal' : 'numeric', spellcheck: 'false' });
        input.value = value;
        let committed = value;
        const msg = el('span', { class: 'nbt-msg' });
        // 和原文不同（手动改过或导入翻译表写入的）：标记“已修改”
        const tag = orig != null ? el('span', { class: 'nbt-tag-edited', text: L('e_modified') }) : null;
        const mark = () => {
            const on = orig != null ? committed !== orig : input.classList.contains('edited');
            input.classList.toggle('edited', on);
            if (tag) tag.hidden = !on;
        };
        // 有长度限制的字段（成书页、书名）显示字数
        const limit = isStr && session.limitOf ? session.limitOf(ref) : null;
        const counter = limit ? el('span', { class: 'nbt-count' }) : null;
        const updateCount = () => {
            if (!counter) return;
            const n = input.value.length, lines = input.value.split('\n').length;
            const over = n > limit.max || Boolean(limit.lines && lines > limit.lines);
            counter.textContent = L('c_chars', n, limit.max) + (limit.lines ? L('c_lines', lines, limit.lines) : '') + (over ? t(limit.auto ? 'c_autopage' : 'c_over') : '');
            counter.classList.toggle('over', over);
        };
        updateCount();
        if (counter) input.addEventListener('input', updateCount);
        const commit = () => {
            if (input.value === committed) return;
            try {
                committed = session.setValue(ref, input.value);
                input.value = committed;
                input.classList.add('edited');
                mark();
                input.classList.remove('invalid');
                msg.textContent = '';
                onChange && onChange();
            } catch (e) {
                input.classList.add('invalid');
                msg.textContent = e.message;
            }
        };
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        if (!isStr) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
        if (isStr) {
            // 按内容自动撑开（包括长文本自动折行），最多约 10 行，之后滚动
            const fit = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 220) + 'px'; };
            input.addEventListener('input', fit);
            requestAnimationFrame(fit);
            if (typeof IntersectionObserver !== 'undefined') {
                // 在折叠 / 隐藏的面板里创建时高度为 0，显示出来后再算一次
                const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { fit(); io.disconnect(); } });
                io.observe(input);
            }
        }
        mark();
        return el('div', { class: 'nbt-value' }, input, tag, counter, msg);
    }

    function mount(container, session, { onChange, downloadCsv } = {}) {
        container.innerHTML = '';
        container.hidden = false;
        const editsBadge = el('span', { class: 'nbt-badge' });
        const updateBadge = () => { editsBadge.textContent = session.edits ? L('e_edits', session.edits) : L('e_no_edits'); };
        const noticeEl = el('p', { class: 'nbt-notice' });
        const changed = () => {
            updateBadge();
            noticeEl.textContent = session.notice || '';
            onChange && onChange();
            if (session.structureChanged) {
                // 自动分页插入了新页：重新渲染列表，引用已更新
                session.structureChanged = false;
                untr.length = 0;
                untr.push(...session.ctx.untranslatable.filter(u => u.ref));
                renderManual();
                if (q.value.trim()) doSearch();
            }
        };
        updateBadge();

        const untr = session.ctx.untranslatable.filter(u => u.ref);
        const tabs = [
            { id: 'manual', name: L('e_tab_manual', untr.length) },
            { id: 'search', name: L('e_tab_search') },
            { id: 'browse', name: L('e_tab_browse') },
        ];
        const panes = {};
        const tabBar = el('div', { class: 'nbt-tabs' });
        const show = (id) => {
            tabBar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.id === id));
            for (const [k, p] of Object.entries(panes)) p.hidden = k !== id;
        };
        for (const t of tabs) tabBar.append(el('button', { 'data-id': t.id, text: t.name, onclick: () => show(t.id) }));

        container.append(
            el('div', { class: 'nbt-head' }, el('span', { class: 'nbt-title', text: L('e_title') }), editsBadge),
            noticeEl,
            el('p', { class: 'nbt-hint', text: L('e_hint') }),
            tabBar,
        );

        // ---------- 需人工翻译 ----------
        const manual = el('div', { class: 'nbt-pane' });
        const fileIn = el('input', { type: 'file', accept: '.csv', hidden: true });
        const importMsg = el('span', { class: 'nbt-msg' });
        const alertMsg = (t) => { searchMsg.textContent = t; };
        const searchMsg = el('p', { class: 'nbt-hint' });
        fileIn.addEventListener('change', async () => {
            const f = fileIn.files[0];
            if (!f) return;
            try {
                // Excel 默认存成 GBK（“CSV（逗号分隔）”）：不是合法 UTF-8 时按 GB18030 读
                const buf = await f.arrayBuffer();
                let text;
                try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
                catch (e) { text = new TextDecoder('gb18030').decode(buf); }
                const r = session.importCsv(text);
                importMsg.textContent = L('e_imported', r.applied, r.skipped);
                renderManual();
                if (q.value.trim()) doSearch();
                alertMsg(L('e_imported', r.applied, r.skipped));
                changed();
            } catch (e) { importMsg.textContent = L('e_import_fail', e.message); }
            fileIn.value = '';
        });
        const list = el('div', { class: 'nbt-list' });
        // ---- 筛选 + 分页（内容很多时）----
        // 类别勾选：取消勾选的类别不显示，也不进入导出的待翻译表（如命令方块名称）
        const catOf = NS.worldCategoryOf;
        const cats = [...new Set(untr.map(catOf))];
        const HKEY = 'addon-i18n.hiddenCats';
        try { for (const c of JSON.parse(localStorage.getItem(HKEY) || '[]')) if (cats.includes(c)) session.hiddenCats.add(c); } catch (e) { /* 无存储 */ }
        const saveHidden = () => { try { localStorage.setItem(HKEY, JSON.stringify([...session.hiddenCats])); } catch (e) { /* 无存储 */ } };
        const catBox = el('div', { class: 'nbt-cats' }, el('span', { class: 'nbt-cats-title', text: L('e_cats') }),
            ...cats.map(c => {
                const cb = el('input', { type: 'checkbox' });
                cb.checked = !session.hiddenCats.has(c);
                cb.addEventListener('change', () => {
                    if (cb.checked) session.hiddenCats.delete(c); else session.hiddenCats.add(c);
                    saveHidden(); page = 0; renderManual(); changed();
                });
                return el('label', { class: 'opt-check nbt-cat' }, cb, ` ${c}（${untr.filter(u => catOf(u) === c).length}）`);
            }));
        const kw = el('input', { class: 'nbt-filter', type: 'search', placeholder: L('e_filter_ph'), spellcheck: 'false' });
        const onlyTodo = el('input', { type: 'checkbox' });
        // 原文相同的条目合并成一行：改一次，所有位置一起改
        const mergeSame = el('input', { type: 'checkbox', checked: true });
        const grouped = (items) => {
            const out = [], map = new Map();
            for (const u of items) {
                const lim = session.limitOf ? session.limitOf(u.ref) : null;
                const key = !mergeSame.checked || (lim && lim.auto) ? '\u0001' + u.ref : `${u.text}\u0000${u.reason || ''}\u0000${catOf(u)}`;
                let g = map.get(key);
                if (!g) { g = { u, refs: [], files: [] }; map.set(key, g); out.push(g); }
                g.refs.push(u.ref);
                if (!g.files.includes(u.file)) g.files.push(u.file);
            }
            return out;
        };
        const groupSession = (g) => g.refs.length < 2 ? session : Object.assign(Object.create(session), {
            setValue(ref, v) { let first; for (const r of g.refs) { const x = session.setValue(r, v); if (first === undefined) first = x; } return first; },
        });
        const pager = el('div', { class: 'nbt-pager' });
        const MPAGE = 50;
        let page = 0;
        const filtered = () => {
            const k = kw.value.trim().toLowerCase();
            return untr.filter(u => {
                if (session.hiddenCats.has(catOf(u))) return false;
                if (k && !(`${u.text} ${u.file} ${u.where}`.toLowerCase().includes(k))) return false;
                if (onlyTodo.checked && session.getText(u.ref) !== u.text) return false;   // 已改过的不显示
                return true;
            });
        };
        const renderManual = () => {
            list.innerHTML = '';
            pager.innerHTML = '';
            if (!untr.length) { list.append(el('p', { class: 'nbt-empty', text: L('e_none') })); return; }
            const items = grouped(filtered());
            const pages = Math.max(1, Math.ceil(items.length / MPAGE));
            page = Math.min(page, pages - 1);
            for (const g of items.slice(page * MPAGE, page * MPAGE + MPAGE)) {
                const u = g.u;
                const cur = session.getText(u.ref);
                if (cur == null) continue;
                const r = session.resolve(u.ref);
                const more = g.files.length > 1 ? ` ${L('e_more_files', g.files.length - 1)}` : '';
                list.append(el('div', { class: 'nbt-row' },
                    el('div', { class: 'nbt-loc' }, el('b', { text: u.where }), el('span', { text: ` · ${g.files[0]}${more}` }),
                        g.refs.length > 1 ? el('span', { class: 'nbt-tag-dup', text: L('e_dup', g.refs.length) }) : null),
                    el('div', { class: 'nbt-orig', text: L('e_orig', u.text) }),
                    valueEditor(groupSession(g), u.ref, r.node.t, cur, changed, u.text),
                ));
            }
            if (!items.length) list.append(el('p', { class: 'nbt-empty', text: L('e_no_match') }));
            pager.append(
                el('button', { class: 'btn btn-secondary btn-sm', text: L('e_prev'), disabled: page === 0, onclick: () => { page--; renderManual(); list.scrollTop = 0; } }),
                el('span', { text: L('e_page', page + 1, pages, items.length) }),
                el('button', { class: 'btn btn-secondary btn-sm', text: L('e_next'), disabled: page >= pages - 1, onclick: () => { page++; renderManual(); list.scrollTop = 0; } }),
            );
        };
        let ft;
        onlyTodo.addEventListener('change', () => { page = 0; renderManual(); });
        mergeSame.addEventListener('change', () => { page = 0; renderManual(); });
        kw.addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(() => { page = 0; renderManual(); }, 200); });
        manual.append(
            el('div', { class: 'nbt-tools' },
                el('button', { class: 'btn btn-secondary btn-sm', text: L('e_export'), onclick: () => downloadCsv && downloadCsv(session.workbook()['untranslatable.csv']) }),
                el('button', { class: 'btn btn-secondary btn-sm', text: L('e_import'), onclick: () => fileIn.click() }),
                fileIn, importMsg),
            el('p', { class: 'nbt-hint', text: L('e_csv_hint') }),
            catBox,
            el('div', { class: 'nbt-filters' }, kw, el('label', { class: 'opt-check' }, onlyTodo, L('e_only_todo')), el('label', { class: 'opt-check' }, mergeSame, L('e_merge'))),
            list,
            pager,
        );
        renderManual();
        panes.manual = manual;

        // ---------- 搜索 ----------
        const search = el('div', { class: 'nbt-pane' });
        const q = el('input', { class: 'nbt-search nbt-grow', type: 'search', placeholder: L('e_search_ph'), spellcheck: 'false' });
        const results = el('div', { class: 'nbt-list' });
        let timer;
        const doSearch = () => {
            results.innerHTML = '';
            const hits = session.search(q.value, 301);
            if (!q.value.trim()) return;
            if (!hits.length) { results.append(el('p', { class: 'nbt-empty', text: L('e_not_found') })); return; }
            for (const h of hits.slice(0, 300)) {
                results.append(el('div', { class: 'nbt-row' },
                    el('div', { class: 'nbt-loc' }, el('b', { text: h.pathText || L('e_root') }), el('span', { class: 'nbt-type', text: TYPE_NAME[h.type] }), el('span', { text: ` · ${h.label}` })),
                    valueEditor(session, h.ref, h.type, h.value, changed),
                ));
            }
            if (hits.length > 300) results.append(el('p', { class: 'nbt-empty', text: L('e_only300') }));
        };
        q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 200); });
        const exportSearch = () => {
            const hits = session.search(q.value, 1e6).filter(h => h.type === T.STRING || EDITABLE.has(h.type));
            if (!hits.length) return;
            const rows = [['ref', 'location', 'path', 'type', 'text', 'translation'], ...hits.map(h => [h.ref, h.label, h.pathText, TYPE_NAME[h.type], h.value, ''])];
            const csv = '\ufeff' + rows.map(r => r.map(x => { const t = String(x); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
            downloadCsv && downloadCsv(csv, `search_${q.value.trim().replace(/[^\w\u4e00-\u9fff]+/g, '_').slice(0, 20)}`);
        };
        search.append(
            el('div', { class: 'nbt-tools' }, q,
                el('button', { class: 'btn btn-secondary btn-sm', text: L('e_export_search'), onclick: exportSearch }),
                el('button', { class: 'btn btn-secondary btn-sm', text: L('e_import'), onclick: () => fileIn.click() })),
            el('p', { class: 'nbt-hint', text: L('e_search_hint') }),
            searchMsg,
            results);
        panes.search = search;

        // ---------- 浏览 ----------
        const browse = el('div', { class: 'nbt-pane nbt-tree' });
        const renderNode = (parent, rec, path, t, v, name) => {
            const ref = `${rec.id}|${JSON.stringify(path)}`;
            if (t === T.COMPOUND || t === T.LIST) {
                const count = t === T.COMPOUND ? v.length : v.items.length;
                const d = el('details', {}, el('summary', {}, el('span', { class: 'nbt-key', text: name }), el('span', { class: 'nbt-type', text: `${TYPE_NAME[t]}${t === T.LIST ? `<${TYPE_NAME[v.et] || '?'}>` : ''} · ${count}` })));
                const kids = el('div', { class: 'nbt-children' });
                d.append(kids);
                let done = false;
                d.addEventListener('toggle', () => {
                    if (!d.open || done) return;
                    done = true;
                    const items = t === T.COMPOUND ? v.map(c => [c.n, c.t, c.v]) : v.items.map((x, i) => [`[${i}]`, v.et, x]);
                    const seg = (i) => (t === T.COMPOUND ? items[i][0] : i);
                    let shown = 0;
                    const more = () => {
                        const end = Math.min(items.length, shown + PAGE);
                        for (; shown < end; shown++) renderNode(kids, rec, [...path, seg(shown)], items[shown][1], items[shown][2], items[shown][0]);
                        if (shown < items.length) kids.append(el('button', { class: 'btn btn-secondary btn-sm', text: L('e_more', items.length - shown), onclick: (e) => { e.target.remove(); more(); } }));
                    };
                    more();
                });
                parent.append(d);
            } else if (EDITABLE.has(t)) {
                parent.append(el('div', { class: 'nbt-leaf' }, el('span', { class: 'nbt-key', text: name }), el('span', { class: 'nbt-type', text: TYPE_NAME[t] }),
                    valueEditor(session, ref, t, NS.worldDisplayValue(t, v), changed)));
            } else {
                const len = v && v.length != null ? v.length : '';
                parent.append(el('div', { class: 'nbt-leaf' }, el('span', { class: 'nbt-key', text: name }), el('span', { class: 'nbt-type', text: L('e_readonly', `${TYPE_NAME[t]} · ${len}`) })));
            }
        };
        const groups = [
            [L('b_level'), session.records.filter(r => r.kind === 'level')],
            [L('b_block'), session.records.filter(r => r.kind === 'block')],
            [L('b_player'), session.records.filter(r => r.kind === 'player')],
            [L('b_actor'), session.records.filter(r => r.kind === 'actor')],
            [L('b_structure'), session.records.filter(r => r.kind === 'structure')],
        ].filter(([, recs]) => recs.length);
        for (const [gname, recs] of groups) {
            const roots = recs.flatMap(rec => rec.tags.map((tg, ri) => ({ rec, ri, tg })));
            const g = el('details', {}, el('summary', {}, el('span', { class: 'nbt-key', text: gname }), el('span', { class: 'nbt-type', text: String(roots.length) })));
            const kids = el('div', { class: 'nbt-children' });
            g.append(kids);
            let shown = 0;
            const more = () => {
                const end = Math.min(roots.length, shown + PAGE);
                for (; shown < end; shown++) {
                    const { rec, ri, tg } = roots[shown];
                    renderNode(kids, rec, [ri], tg.t, tg.v, NS.worldRootLabel(rec, ri));
                }
                if (shown < roots.length) kids.append(el('button', { class: 'btn btn-secondary btn-sm', text: L('e_more', roots.length - shown), onclick: (e) => { e.target.remove(); more(); } }));
            };
            let done = false;
            g.addEventListener('toggle', () => { if (g.open && !done) { done = true; more(); } });
            browse.append(g);
        }
        panes.browse = browse;

        container.append(manual, search, browse);
        show(untr.length ? 'manual' : 'search');
    }

    NS.mountWorldEditor = mount;
})(typeof globalThis !== 'undefined' ? globalThis : this);
