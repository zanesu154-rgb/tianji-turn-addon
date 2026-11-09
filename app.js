/* ================================================================
 *  栈主的附加包汉化工具 - 界面与 zip 读写
 *  核心逻辑在 src/ 下（与 DOM 无关，可单独测试）
 * ================================================================ */

const NS = window.AddonI18n;

const state = {
    originalName: '',
    resultBlob: null,
    resultName: '',
    workbookBlob: null,
    logContent: '',
};

let logAutoExpanded = false;

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const dropZone = $('drop-zone');
const fileInput = $('file-input');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const downloadLogBtn = $('download-log');
const downloadResultBtn = $('download-result');
const downloadWorkbookBtn = $('download-workbook');
const logEl = $('log');
const toggleLogBtn = $('toggle-log');
const summaryEl = $('summary');

// ================================================================
//  日志 / 进度
// ================================================================

/** 大量逐条记录：日志文件里全部保留，页面只显示前 100 条 */
function logMany(items, fmt, type = 'warn') {
    const SHOW = 100;
    items.forEach((u, i) => {
        const line = `[${new Date().toLocaleTimeString()}] ${fmt(u)}`;
        if (i < SHOW) log(fmt(u), type);
        else state.logContent += line + '\n';
    });
    if (items.length > SHOW) log(`……另有 ${items.length - SHOW} 条未在页面显示（见“下载日志”或下方编辑器 / 翻译表）`, type);
}

// 日志：先攒起来，每帧最多写一次页面（上万行时逐行写会卡死，手机上尤其明显）
let logQueue = [];
let logFlushScheduled = false;
function flushLog() {
    logFlushScheduled = false;
    if (!logQueue.length) return;
    const frag = document.createDocumentFragment();
    for (const [line, type] of logQueue) {
        const span = document.createElement('span');
        span.className = `log-${type}`;
        span.textContent = line + '\n';
        frag.appendChild(span);
    }
    logQueue = [];
    logEl.appendChild(frag);
    // 页面上最多保留 3000 行，完整内容在“下载日志”里
    while (logEl.childNodes.length > 3000) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
}
function log(msg, type = 'info') {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.logContent += line + '\n';
    if (!logAutoExpanded) {
        logEl.classList.remove('collapsed');
        toggleLogBtn.textContent = '收起';
        logAutoExpanded = true;
    }
    logQueue.push([line, type]);
    if (!logFlushScheduled) { logFlushScheduled = true; requestAnimationFrame(flushLog); }
}

function setProgress(percent, text) {
    progressFill.style.width = `${percent}%`;
    if (text) progressText.textContent = text;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================================================================
//  zip 文件系统适配
// ================================================================

class ZipFS {
    constructor(zip) {
        this.entries = new Map();
        for (const [p, f] of Object.entries(zip.files)) {
            if (!f.dir) this.entries.set(p.replace(/\\/g, '/').replace(/^\/+/, ''), f);
        }
    }
    list() { return [...this.entries.keys()]; }
    async readText(p) {
        const v = this.entries.get(p);
        if (v === undefined) throw new Error(`文件不存在: ${p}`);
        if (typeof v === 'string') return v;
        if (v instanceof Uint8Array) return new TextDecoder().decode(v);
        return v.async('string');
    }
    writeText(p, s) { this.entries.set(p, s); }
    async readBytes(p) {
        const v = this.entries.get(p);
        if (v === undefined) throw new Error(`文件不存在: ${p}`);
        if (typeof v === 'string') return new TextEncoder().encode(v);
        if (v instanceof Uint8Array) return v;
        return v.async('uint8array');
    }
    writeBytes(p, b) { this.entries.set(p, b); }
    move(a, b) {
        const v = this.entries.get(a);
        this.entries.delete(a);
        this.entries.set(b, v);
    }
    async toZip() {
        const z = new JSZip();
        for (const [p, v] of this.entries) {
            z.file(p, typeof v === 'string' || v instanceof Uint8Array ? v : await v.async('uint8array'));
        }
        return z;
    }
}

/** 把压缩包内嵌套的 .mcpack / .mcaddon 解压成文件夹 */
async function extractInnerPacks(zip) {
    let extracted = 0;
    for (let depth = 0; depth < 5; depth++) {
        const inner = Object.keys(zip.files).filter(p => !zip.files[p].dir && /\.(mcpack|mcaddon)$/i.test(p));
        if (!inner.length) break;
        for (const packPath of inner) {
            try {
                const innerZip = await JSZip.loadAsync(await zip.files[packPath].async('uint8array'));
                const baseDir = packPath.replace(/\.[^.]+$/, '');
                const paths = Object.keys(innerZip.files).filter(p => !innerZip.files[p].dir).map(p => p.replace(/\\/g, '/'));
                // 只有一个顶层文件夹时去掉它
                let strip = '';
                const tops = new Set(paths.map(p => p.split('/')[0]));
                if (tops.size === 1 && paths.every(p => p.includes('/'))) strip = [...tops][0] + '/';
                for (const [p, f] of Object.entries(innerZip.files)) {
                    if (f.dir) continue;
                    let rel = p.replace(/\\/g, '/');
                    if (strip && rel.startsWith(strip)) rel = rel.slice(strip.length);
                    zip.file(`${baseDir}/${rel.replace(/^\/+/, '')}`, await f.async('uint8array'));
                }
                zip.remove(packPath);
                extracted++;
                log(`[解压] ${packPath} → ${baseDir}/`);
            } catch (e) {
                log(`[解压失败] ${packPath}: ${e.message}`, 'warn');
            }
        }
    }
    return extracted;
}

// ================================================================
//  模式：附加包 / 世界存档
// ================================================================

let mode = 'addon';
const MODE_TEXT = {
    addon: { title: '点击上传 .mcaddon / .mcpack / .zip', hint: '处理 .mcaddon / .mcpack：物品、方块、实体、对话、UI、脚本等文本' },
    world: { title: '点击上传 .mcworld / .mctemplate / .mcstructure', hint: '处理世界存档或结构文件：告示牌、命令方块、NPC → 翻译键，并生成对应的资源包；无法翻译的文本可在 NBT 编辑器中修改。处理前请备份' },
};
function setMode(m) {
    mode = m;
    document.body.classList.toggle('mode-world', m === 'world');
    document.querySelectorAll('.mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    $('drop-title').textContent = MODE_TEXT[m].title;
    $('mode-hint').textContent = MODE_TEXT[m].hint;
}
document.querySelectorAll('.mode-tab').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ================================================================
//  选项
// ================================================================

function readOptions() {
    const targets = $('opt-targets').value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
        .filter(s => /^[a-z]{2,3}_[A-Z]{2,4}$/.test(s));
    return {
        sourceLang: $('opt-source').value,
        targetLangs: targets.length ? targets : ['en_US'],
        processScripts: $('opt-scripts').checked,
        injectRuntime: $('opt-runtime').checked,
        splitNewlines: $('opt-split').checked,
        sayMode: $('opt-say').value,
        listCommandBlockNames: $('opt-cbname').checked,
        fillMissing: $('opt-fill').checked,
        placeholderNames: $('opt-placeholder').checked,
        scriptLangFields: $('opt-langfields').value,
    };
}

// ================================================================
//  结果摘要
// ================================================================

function renderSummary(res) {
    const s = res.summary;
    const untr = res.ctx.untranslatable;
    const list = (items, fmt) => `<ul>${items.slice(0, 200).map(x => `<li>${fmt(x)}</li>`).join('')}${items.length > 200 ? `<li>…共 ${items.length} 条</li>` : ''}</ul>`;
    let html = `<div class="summary-stats">
        <div class="stat"><b>${s.newKeys}</b><span>提取的文本</span></div>
        <div class="stat"><b>${s.processedFiles}</b><span>${s.world ? '自动修改的记录' : '修改的文件'}</span></div>
        <div class="stat"><b>${s.untranslatable}</b><span>${s.world ? '需人工处理' : '无法本地化'}</span></div>
        <div class="stat"><b>${escapeHtml(s.sourceLang)}</b><span>原文语言</span></div>
    </div>`;
    if (s.structure) {
        if (s.createdRP) html += `<p class="summary-note">下载的 zip 里包含改好的结构文件和翻译资源包 <code>${escapeHtml(s.createdRP)}</code>，使用该结构的世界需启用这个资源包。</p>`;
        if (s.untranslatable) html += `<p class="summary-note">有 ${s.untranslatable} 处文本游戏不支持翻译键，可在下方 NBT 编辑器中直接修改。</p>`;
    } else if (s.world) {
        if (s.createdRP) html += `<p class="summary-note">下载时会在存档内新建资源包 <code>${escapeHtml(s.createdRP)}</code> 并登记到 world_resource_packs.json，打开存档自动加载。</p>`;
        if (s.untranslatable) html += `<p class="summary-note">有 ${s.untranslatable} 处文本游戏不支持翻译键，可在下方 NBT 编辑器中直接修改。</p>`;
    } else if (s.createdRP) html += `<p class="summary-note">附加包没有资源包，已新建 <code>${escapeHtml(s.createdRP)}/</code> 存放翻译，并让行为包依赖它。</p>`;
    if (s.placeholders) html += `<p class="summary-note">${s.placeholders} 个物品/方块/实体原本没有名称，已按 ID 生成英文占位名，请在 lang 中确认。</p>`;
    if (s.inputGroups) html += `<p class="summary-note">脚本里有 ${s.inputGroups} 处匹配玩家聊天输入的关键词/正则。游戏不会翻译玩家输入，已列在翻译表的 <code>input_aliases.csv</code> 中，可按语言补充说法后交给作者加进正则。</p>`;
    if (untr.length && !s.world) {
        html += `<details><summary>无法本地化的文本（${untr.length}）—— 游戏不支持翻译键，需要手动处理</summary>${list(untr, u =>
            `<code>${escapeHtml(u.text)}</code> — ${escapeHtml(u.reason)}<br><small>${escapeHtml(u.file)} · ${escapeHtml(u.where)}</small>`)}</details>`;
    }
    if (s.warnings.length) {
        html += `<details><summary>注意事项（${s.warnings.length}）</summary>${list(s.warnings, w => escapeHtml(w))}</details>`;
    }
    if (s.missingRefs.length) {
        html += `<details><summary>引用了但没有定义的键（${s.missingRefs.length}）</summary>${list(s.missingRefs, ([k, f]) =>
            `<code>${escapeHtml(k)}</code><br><small>${escapeHtml(f)}</small>`)}</details>`;
    }
    summaryEl.innerHTML = html;
    summaryEl.hidden = false;
}

function worldSummary(session) {
    const lang = session.opt.sourceLang === 'auto' ? NS.detectSourceLang([...session.ctx.entries.values()].map(e => e.value)) : session.opt.sourceLang;
    return {
        world: true, newKeys: session.ctx.entries.size, processedFiles: session.records.filter(r => r.dirty).length,
        untranslatable: session.ctx.untranslatable.length, sourceLang: lang, warnings: session.ctx.warnings, missingRefs: [],
        createdRP: session.ctx.entries.size ? 'resource_packs/world_texts/' : null, packs: [], inputGroups: 0,
    };
}

/** 单独的 .mcstructure：打开为编辑会话 */
async function processStructure(file) {
    if (mode !== 'world') { setMode('world'); log('结构文件在“世界存档”页面处理'); }
    const session = await NS.openStructure(file.name, new Uint8Array(await file.arrayBuffer()), readOptions(), (m, t) => log(m, t || 'info'));
    state.session = session;
    state.fs = null;
    state.resultName = `${state.originalName}_i18n.zip`;
    logMany(session.ctx.untranslatable, u => `[需人工处理] ${u.file} ${u.where}: ${u.text}`);
    renderSummary({ ctx: session.ctx, summary: { ...worldSummary(session), createdRP: session.ctx.entries.size ? `${state.originalName}_texts.mcpack` : null, structure: true } });
    NS.mountWorldEditor($('nbt-editor'), session, {
        onChange: () => { state.resultBlob = null; state.workbookBlob = null; },
        downloadCsv: (text, name) => downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${state.originalName}_${name || 'untranslatable'}.csv`),
    });
    setProgress(100, '完成！可在下方编辑后下载');
    log(`✅ 分析完成：自动转换 ${session.ctx.entries.size} 条，需人工处理 ${session.ctx.untranslatable.length} 处`);
    downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = false;
}

/** 存档 / 结构：按当前（含手动修改的）状态生成文件 */
async function buildWorldOutputs() {
    if (state.resultBlob && state.workbookBlob) return;
    if (!state.fs) {
        // 结构文件：输出 zip = 改好的 .mcstructure + 翻译资源包 .mcpack
        setProgress(90, '生成中...');
        const res = await state.session.build();
        const out = new JSZip();
        out.file(`${state.originalName}.mcstructure`, res.structure);
        if (res.pack) {
            const pack = new JSZip();
            for (const [p, t] of res.pack) pack.file(p, t);
            out.file(`${state.originalName}_texts.mcpack`, await pack.generateAsync({ type: 'uint8array' }));
            out.file('README.txt', '1. 导入 ' + state.originalName + '_texts.mcpack，并在使用该结构的世界里启用这个资源包；\n2. 用 ' + state.originalName + '.mcstructure 替换原结构文件（附加包 structures/ 目录或结构方块导入）。\n');
        }
        state.resultBlob = await out.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const wb = new JSZip();
        for (const [name, content] of Object.entries(res.workbook)) wb.file(name, content);
        wb.file('process.log', state.logContent);
        state.workbookBlob = await wb.generateAsync({ type: 'blob' });
        log(`✅ 已生成 ${state.resultName}（手动修改 ${state.session.edits} 处）`);
        setProgress(100, '完成！');
        return;
    }
    setProgress(90, '写入存档...');
    const res = await state.session.build(state.fs, (m, t) => log(m, t || 'info'));
    const outZip = await state.fs.toZip();
    state.resultBlob = await outZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const wb = new JSZip();
    for (const [name, content] of Object.entries(res.workbook)) wb.file(name, content);
    wb.file('process.log', state.logContent);
    state.workbookBlob = await wb.generateAsync({ type: 'blob' });
    log(`✅ 已生成 ${state.resultName}（手动修改 ${state.session.edits} 处）`);
    setProgress(100, '完成！');
}

// ================================================================
//  主流程
// ================================================================

// 页面各脚本文件版本不一致（通常是浏览器缓存）时，提示强制刷新
const REQUIRED = ['runPipeline', 'processScript', 'collectTranslationGroups', 'collectUiVarUsage', 'translateCommand', 'regexPhrases', 'runWorldPipeline'];
function checkVersion() {
    const missing = REQUIRED.filter(n => typeof NS[n] !== 'function');
    if (missing.length) {
        log(`❌ 页面文件版本不一致（缺少 ${missing.join(', ')}），可能是浏览器缓存了旧文件。请按 Ctrl+F5（手机上清除网站缓存）强制刷新后重试。`, 'error');
        return false;
    }
    return true;
}

async function processFile(file) {
    const ext = (file.name.match(/\.(mcaddon|mcpack|zip|mcworld|mctemplate|mcstructure)$/i) || [, 'mcaddon'])[1].toLowerCase();
    state.originalName = file.name.replace(/\.(mcaddon|mcpack|zip|mcworld|mctemplate|mcstructure)$/i, '');
    state.logContent = '';
    state.resultBlob = state.workbookBlob = null;
    logEl.innerHTML = '';
    logQueue = [];
    logAutoExpanded = false;
    summaryEl.hidden = true;
    downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = true;
    setProgress(0, '加载中...');

    log(`开始处理: ${file.name}（${(file.size / 1024).toFixed(1)} KB）  工具版本 ${($('app-version') || {}).textContent || ''}`);
    if (!checkVersion()) { setProgress(0, '请刷新页面'); downloadLogBtn.disabled = false; return; }

    try {
        if (ext === 'mcstructure') { await processStructure(file); return; }
        const zip = await JSZip.loadAsync(file);
        const inner = await extractInnerPacks(zip);
        if (inner) log(`解压了 ${inner} 个内层包`);

        const fs = new ZipFS(zip);
        log(`共 ${fs.list().length} 个文件`);
        setProgress(5, '分析中...');

        const options = {
            ...readOptions(),
            baseName: state.originalName,
            onProgress: (r, p) => setProgress(5 + Math.floor(r * 75), `处理: ${p.split('/').pop()}`),
        };
        // 压缩包里有 level.dat + db/ → 世界存档
        const isWorld = fs.list().some(p => /(^|\/)level\.dat$/.test(p)) && fs.list().some(p => /(^|\/)db\/CURRENT$/.test(p));
        if (isWorld && mode !== 'world') { setMode('world'); log('检测到世界存档，已切换到“世界存档”模式'); }
        if (!isWorld && mode === 'world') { setMode('addon'); log('这不是世界存档，已切换到“附加包”模式'); }
        state.session = null;
        state.addonSession = null; state.addonFs = null;
        state.fs = fs;
        state.ext = ext;
        $('nbt-editor').hidden = true;
        if (isWorld) {
            // 存档：先打开并自动转换（只改内存），可在 NBT 编辑器里继续手动修改，下载时才写出
            const session = await NS.openWorld(fs, options, (m, t) => log(m, t || 'info'));
            state.session = session;
            logMany(session.ctx.untranslatable, u => `[需人工处理] ${u.file} ${u.where}: ${u.text}`);
            state.resultName = `${state.originalName}_i18n.${ext === 'mctemplate' ? 'mctemplate' : 'mcworld'}`;
            renderSummary({ ctx: session.ctx, summary: worldSummary(session) });
            NS.mountWorldEditor($('nbt-editor'), session, {
                onChange: () => { state.resultBlob = null; state.workbookBlob = null; },
                downloadCsv: (text, name) => downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${state.originalName}_${name || 'untranslatable'}.csv`),
            });
            setProgress(100, '完成！可在下方编辑后下载');
            log(`✅ 分析完成：自动转换 ${session.ctx.entries.size} 条，需人工处理 ${session.ctx.untranslatable.length} 处`);
            downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = false;
            return;
        }
        const res = await NS.runPipeline(fs, options, (m, t) => log(m, t || 'info'));
        const s = res.summary;

        for (const w of s.warnings) log(`⚠ ${w}`, 'warn');
        logMany(res.ctx.untranslatable, u => `[无法本地化] ${u.file} ${u.where}: ${u.text}（${u.reason}）`);
        log(`新增翻译键 ${s.newKeys} 条，包名/描述 ${s.packKeys} 条，修改文件 ${s.processedFiles} 个`);

        // 附加包里的结构有需人工翻译的文字：显示编辑器，可手动改或导入填好的翻译表，下载时写回
        if (res.structureSession) {
            state.addonSession = res.structureSession;
            state.addonFs = fs;
            state.addonWorkbook = res.workbook;
            NS.mountWorldEditor($('nbt-editor'), res.structureSession, {
                onChange: () => { state.resultBlob = null; },
                downloadCsv: (text, name) => downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${state.originalName}_${name || 'structures'}.csv`),
            });
            $('nbt-editor').hidden = false;
            log(`附加包里的结构有 ${res.structureSession.ctx.untranslatable.length} 处需人工翻译，可在下方编辑器修改，或在 untranslatable.csv 的 translation 列填写后导入`);
        }

        setProgress(85, '打包中...');
        const outZip = await fs.toZip();
        state.resultBlob = await outZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const multiPack = s.packs.length > 1 || s.restructured;
        const outExt = ext === 'mcpack' && !multiPack ? 'mcpack' : 'mcaddon';
        state.resultName = `${state.originalName}_i18n.${outExt}`;

        // 翻译表：CSV（Excel 可直接打开）+ 源语言 lang + 报告
        const wb = new JSZip();
        for (const [name, content] of Object.entries(res.workbook)) wb.file(name, content);
        wb.file('process.log', state.logContent);
        state.workbookBlob = await wb.generateAsync({ type: 'blob' });

        renderSummary(res);
        setProgress(100, '完成！');
        log(`✅ 处理完成: ${state.resultName}`);
        downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = false;
    } catch (e) {
        log(`❌ 错误: ${e.message}`, 'error');
        setProgress(0, '处理失败');
        console.error(e);
        downloadLogBtn.disabled = false;
    }
}

// ================================================================
//  下载
// ================================================================

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 附加包：结构被手动修改后重新打包 */
async function rebuildAddonIfEdited() {
    if (!state.addonSession || state.resultBlob) return;
    setProgress(90, '写入修改...');
    const n = state.addonSession.applyTo(state.addonFs);
    const outZip = await state.addonFs.toZip();
    state.resultBlob = await outZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    log(`✅ 已重新打包（结构手动修改 ${state.addonSession.edits} 处，写回 ${n} 个结构文件）`);
    setProgress(100, '完成！');
}

downloadResultBtn.addEventListener('click', async () => {
    try {
        await rebuildAddonIfEdited();
        if (state.session) await buildWorldOutputs();
        if (state.resultBlob) downloadBlob(state.resultBlob, state.resultName);
    } catch (e) { log(`❌ 生成失败: ${e.message}`, 'error'); }
});

downloadWorkbookBtn.addEventListener('click', async () => {
    try {
        if (state.session) await buildWorldOutputs();
        if (state.workbookBlob) downloadBlob(state.workbookBlob, `${state.originalName}_translation.zip`);
    } catch (e) { log(`❌ 生成失败: ${e.message}`, 'error'); }
});

downloadLogBtn.addEventListener('click', () => {
    if (state.logContent) {
        downloadBlob(new Blob([state.logContent], { type: 'text/plain;charset=utf-8' }), `${state.originalName}_process.log`);
    }
});

// ================================================================
//  日志折叠 / 文件选择
// ================================================================

toggleLogBtn.addEventListener('click', () => {
    logEl.classList.toggle('collapsed');
    toggleLogBtn.textContent = logEl.classList.contains('collapsed') ? '展开' : '收起';
});

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await processFile(file);
    fileInput.value = '';
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) await processFile(file);
});
