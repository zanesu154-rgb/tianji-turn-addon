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
        if (isStr) input.addEventListener('input', () => { input.rows = Math.min(8, Math.max(1, input.value.split('\n').length)); });
        return el('div', { class: 'nbt-value' }, input, msg);
    }

    function mount(container, session, { onChange, downloadCsv } = {}) {
        container.innerHTML = '';
        container.hidden = false;
        const editsBadge = el('span', { class: 'nbt-badge' });
        const updateBadge = () => { editsBadge.textContent = session.edits ? `已手动修改 ${session.edits} 处` : '尚未手动修改'; };
        const changed = () => { updateBadge(); onChange && onChange(); };
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
            el('p', { class: 'nbt-hint', text: '这些文本游戏只按纯文本显示，无法用翻译键。可以直接在这里改成目标语言；所有修改会在“下载转换后文件”时写回存档。' }),
            tabBar,
        );

        // ---------- 需人工翻译 ----------
        const manual = el('div', { class: 'nbt-pane' });
        const fileIn = el('input', { type: 'file', accept: '.csv', hidden: true });
        const importMsg = el('span', { class: 'nbt-msg' });
        fileIn.addEventListener('change', async () => {
            const f = fileIn.files[0];
            if (!f) return;
            try {
                const r = session.importCsv(await f.text());
                importMsg.textContent = `已导入 ${r.applied} 条，跳过 ${r.skipped} 条（translation 为空或位置不存在）`;
                renderManual();
                changed();
            } catch (e) { importMsg.textContent = `导入失败：${e.message}`; }
            fileIn.value = '';
        });
        const list = el('div', { class: 'nbt-list' });
        const renderManual = () => {
            list.innerHTML = '';
            if (!untr.length) { list.append(el('p', { class: 'nbt-empty', text: '没有需要人工处理的文本。' })); return; }
            for (const u of untr) {
                const cur = session.getText(u.ref);
                if (cur == null) continue;
                const r = session.resolve(u.ref);
                list.append(el('div', { class: 'nbt-row' },
                    el('div', { class: 'nbt-loc' }, el('b', { text: u.where }), el('span', { text: ` · ${u.file}` })),
                    el('div', { class: 'nbt-orig', text: `原文：${u.text}` }),
                    valueEditor(session, u.ref, r.node.t, cur, changed),
                ));
            }
        };
        manual.append(
            el('div', { class: 'nbt-tools' },
                el('button', { class: 'btn btn-secondary btn-sm', text: '导出待翻译表', onclick: () => downloadCsv && downloadCsv(session.workbook()['untranslatable.csv']) }),
                el('button', { class: 'btn btn-secondary btn-sm', text: '导入翻译表', onclick: () => fileIn.click() }),
                fileIn, importMsg),
            el('p', { class: 'nbt-hint', text: '导出的表格在 translation 列填写译文后导入即可批量写回；ref 列是该文本在存档中的位置，请勿修改。' }),
            list,
        );
        renderManual();
        panes.manual = manual;

        // ---------- 搜索 ----------
        const search = el('div', { class: 'nbt-pane' });
        const q = el('input', { class: 'nbt-search', type: 'search', placeholder: '搜索键名或内容，如 CustomName、Text、钻石…', spellcheck: 'false' });
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
        search.append(q, results);
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
            ['实体', session.records.filter(r => r.kind === 'actor')],
        ];
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
