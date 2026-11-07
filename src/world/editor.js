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
    function valueEditor(session, ref, t, value, onChange) {
        const isStr = t === T.STRING;
        const input = isStr
            ? el('textarea', { class: 'nbt-input', rows: Math.min(6, Math.max(1, String(value).split('\n').length)), spellcheck: 'false' })
            : el('input', { class: 'nbt-input nbt-num', type: 'text', inputmode: t === T.FLOAT || t === T.DOUBLE ? 'decimal' : 'numeric', spellcheck: 'false' });
        input.value = value;
        let committed = value;
        const msg = el('span', { class: 'nbt-msg' });
        // 有长度限制的字段（成书页、书名）显示字数
        const limit = isStr && session.limitOf ? session.limitOf(ref) : null;
        const counter = limit ? el('span', { class: 'nbt-count' }) : null;
        const updateCount = () => {
            if (!counter) return;
            const n = input.value.length, lines = input.value.split('\n').length;
            const over = n > limit.max || Boolean(limit.lines && lines > limit.lines);
            counter.textContent = `${n} / ${limit.max} 字${limit.lines ? `，${lines} / ${limit.lines} 行` : ''}${over ? (limit.auto ? '（超出部分会自动分页）' : '（超出游戏限制）') : ''}`;
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
        return el('div', { class: 'nbt-value' }, input, counter, msg);
    }

    function mount(container, session, { onChange, downloadCsv } = {}) {
        container.innerHTML = '';
        container.hidden = false;
        const editsBadge = el('span', { class: 'nbt-badge' });
        const updateBadge = () => { editsBadge.textContent = session.edits ? `已手动修改 ${session.edits} 处` : '尚未手动修改'; };
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
            { id: 'manual', name: `需人工翻译（${untr.length}）` },
            { id: 'search', name: '搜索' },
            { id: 'browse', name: '浏览全部' },
        ];
        const panes = {};
        const tabBar = el('div', { class: 'nbt-tabs' });
        const show = (id) => {
            tabBar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.id === id));
            for (const [k, p] of Object.entries(panes)) p.hidden = k !== id;
        };
        for (const t of tabs) tabBar.append(el('button', { 'data-id': t.id, text: t.name, onclick: () => show(t.id) }));

        container.append(
            el('div', { class: 'nbt-head' }, el('span', { class: 'nbt-title', text: 'NBT 编辑器' }), editsBadge),
            noticeEl,
            el('p', { class: 'nbt-hint', text: '这些文本游戏只按纯文本显示，无法用翻译键。可以直接在这里改成目标语言；所有修改会在“下载转换后文件”时写回存档。' }),
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
                const r = session.importCsv(await f.text());
                importMsg.textContent = `已导入 ${r.applied} 条，跳过 ${r.skipped} 条（translation 为空或位置不存在）`;
                renderManual();
                if (q.value.trim()) doSearch();
                alertMsg(`已导入 ${r.applied} 条，跳过 ${r.skipped} 条`);
                changed();
            } catch (e) { importMsg.textContent = `导入失败：${e.message}`; }
            fileIn.value = '';
        });
        const list = el('div', { class: 'nbt-list' });
        // ---- 筛选 + 分页（内容很多时）----
        const catOf = (u) => u.where.startsWith('/') ? '命令' : /成书|讲台书/.test(u.where) ? '成书' : u.where.replace(/（.*$/, '');
        const cats = [...new Set(untr.map(catOf))];
        const catSel = el('select', { class: 'nbt-filter' }, el('option', { value: '', text: `全部类别（${untr.length}）` }),
            ...cats.map(c => el('option', { value: c, text: `${c}（${untr.filter(u => catOf(u) === c).length}）` })));
        const kw = el('input', { class: 'nbt-filter', type: 'search', placeholder: '筛选原文 / 位置', spellcheck: 'false' });
        const onlyTodo = el('input', { type: 'checkbox' });
        const pager = el('div', { class: 'nbt-pager' });
        const MPAGE = 50;
        let page = 0;
        const filtered = () => {
            const k = kw.value.trim().toLowerCase();
            return untr.filter(u => {
                if (catSel.value && catOf(u) !== catSel.value) return false;
                if (k && !(`${u.text} ${u.file} ${u.where}`.toLowerCase().includes(k))) return false;
                if (onlyTodo.checked && session.getText(u.ref) !== u.text) return false;   // 已改过的不显示
                return true;
            });
        };
        const renderManual = () => {
            list.innerHTML = '';
            pager.innerHTML = '';
            if (!untr.length) { list.append(el('p', { class: 'nbt-empty', text: '没有需要人工处理的文本。' })); return; }
            const items = filtered();
            const pages = Math.max(1, Math.ceil(items.length / MPAGE));
            page = Math.min(page, pages - 1);
            for (const u of items.slice(page * MPAGE, page * MPAGE + MPAGE)) {
                const cur = session.getText(u.ref);
                if (cur == null) continue;
                const r = session.resolve(u.ref);
                list.append(el('div', { class: 'nbt-row' },
                    el('div', { class: 'nbt-loc' }, el('b', { text: u.where }), el('span', { text: ` · ${u.file}` })),
                    el('div', { class: 'nbt-orig', text: `原文：${u.text}` }),
                    valueEditor(session, u.ref, r.node.t, cur, changed),
                ));
            }
            if (!items.length) list.append(el('p', { class: 'nbt-empty', text: '没有符合条件的条目。' }));
            pager.append(
                el('button', { class: 'btn btn-secondary btn-sm', text: '上一页', disabled: page === 0, onclick: () => { page--; renderManual(); list.scrollTop = 0; } }),
                el('span', { text: `第 ${page + 1} / ${pages} 页 · 共 ${items.length} 条` }),
                el('button', { class: 'btn btn-secondary btn-sm', text: '下一页', disabled: page >= pages - 1, onclick: () => { page++; renderManual(); list.scrollTop = 0; } }),
            );
        };
        let ft;
        catSel.addEventListener('change', () => { page = 0; renderManual(); });
        onlyTodo.addEventListener('change', () => { page = 0; renderManual(); });
        kw.addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(() => { page = 0; renderManual(); }, 200); });
        manual.append(
            el('div', { class: 'nbt-tools' },
                el('button', { class: 'btn btn-secondary btn-sm', text: '导出待翻译表', onclick: () => downloadCsv && downloadCsv(session.workbook()['untranslatable.csv']) }),
                el('button', { class: 'btn btn-secondary btn-sm', text: '导入翻译表', onclick: () => fileIn.click() }),
                fileIn, importMsg),
            el('p', { class: 'nbt-hint', text: '内容很多时建议导出表格，在 Excel 等软件里填写 translation 列后导入，批量写回；ref 列是该文本在存档中的位置，请勿修改。' }),
            el('div', { class: 'nbt-filters' }, catSel, kw, el('label', { class: 'opt-check' }, onlyTodo, ' 只看未修改')),
            list,
            pager,
        );
        renderManual();
        panes.manual = manual;

        // ---------- 搜索 ----------
        const search = el('div', { class: 'nbt-pane' });
        const q = el('input', { class: 'nbt-search nbt-grow', type: 'search', placeholder: '搜索键名或内容，如 CustomName、Text、钻石…', spellcheck: 'false' });
        const results = el('div', { class: 'nbt-list' });
        let timer;
        const doSearch = () => {
            results.innerHTML = '';
            const hits = session.search(q.value, 301);
            if (!q.value.trim()) return;
            if (!hits.length) { results.append(el('p', { class: 'nbt-empty', text: '没有找到。' })); return; }
            for (const h of hits.slice(0, 300)) {
                results.append(el('div', { class: 'nbt-row' },
                    el('div', { class: 'nbt-loc' }, el('b', { text: h.pathText || '(根)' }), el('span', { class: 'nbt-type', text: TYPE_NAME[h.type] }), el('span', { text: ` · ${h.label}` })),
                    valueEditor(session, h.ref, h.type, h.value, changed),
                ));
            }
            if (hits.length > 300) results.append(el('p', { class: 'nbt-empty', text: '只显示前 300 条，请输入更具体的关键词。' }));
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
                el('button', { class: 'btn btn-secondary btn-sm', text: '导出搜索结果', onclick: exportSearch }),
                el('button', { class: 'btn btn-secondary btn-sm', text: '导入翻译表', onclick: () => fileIn.click() })),
            el('p', { class: 'nbt-hint', text: '可以把搜索结果（全部，不限 300 条）导出成表格，在 translation 列填写新值后导入，一次改完同类内容，例如搜索 CustomName 批量改所有名字。' }),
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
                        if (shown < items.length) kids.append(el('button', { class: 'btn btn-secondary btn-sm', text: `显示更多（剩 ${items.length - shown}）`, onclick: (e) => { e.target.remove(); more(); } }));
                    };
                    more();
                });
                parent.append(d);
            } else if (EDITABLE.has(t)) {
                parent.append(el('div', { class: 'nbt-leaf' }, el('span', { class: 'nbt-key', text: name }), el('span', { class: 'nbt-type', text: TYPE_NAME[t] }),
                    valueEditor(session, ref, t, NS.worldDisplayValue(t, v), changed)));
            } else {
                const len = v && v.length != null ? v.length : '';
                parent.append(el('div', { class: 'nbt-leaf' }, el('span', { class: 'nbt-key', text: name }), el('span', { class: 'nbt-type', text: `${TYPE_NAME[t]} · ${len}（不可编辑）` })));
            }
        };
        const groups = [
            ['世界设置', session.records.filter(r => r.kind === 'level')],
            ['方块实体', session.records.filter(r => r.kind === 'block')],
            ['玩家', session.records.filter(r => r.kind === 'player')],
            ['实体', session.records.filter(r => r.kind === 'actor')],
            ['结构', session.records.filter(r => r.kind === 'structure')],
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
                if (shown < roots.length) kids.append(el('button', { class: 'btn btn-secondary btn-sm', text: `显示更多（剩 ${roots.length - shown}）`, onclick: (e) => { e.target.remove(); more(); } }));
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
