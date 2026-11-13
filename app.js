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
        else state.logContent += (NS.LogI18n ? NS.LogI18n.tr(line, NS.UI.lang) : line) + '\n';
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
    // 日志在代码里按简体中文写，按当前界面语言翻译后显示 / 写入下载的日志
    if (NS.LogI18n) msg = NS.LogI18n.tr(msg, NS.UI.lang);
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.logContent += line + '\n';
    if (!logAutoExpanded) {
        logEl.classList.remove('collapsed');
        toggleLogBtn.textContent = t('collapse');
        logAutoExpanded = true;
    }
    logQueue.push([line, type]);
    if (!logFlushScheduled) { logFlushScheduled = true; requestAnimationFrame(flushLog); }
}

let progressKey = ['waiting'];
function setProgress(percent, key, ...args) {
    progressFill.style.width = `${percent}%`;
    if (key) { progressKey = [key, ...args]; progressText.textContent = NS.UI.t(key, ...args); }
}

/** 挂载编辑器并记住参数，切换界面语言时重新渲染（编辑内容保存在会话里，不会丢） */
function mountEditor(...args) {
    state.editorArgs = args;
    NS.mountWorldEditor(...args);
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
    remove(p) { this.entries.delete(p); }
    sizeOf(p) { const v = this.entries.get(p); if (v == null) return 0; if (typeof v === 'string') return v.length; if (v instanceof Uint8Array) return v.length; return (v._data && v._data.uncompressedSize) || 0; }
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
const t = (...a) => NS.UI.t(...a);
function setMode(m) {
    mode = m;
    document.body.classList.toggle('mode-world', m === 'world');
    document.querySelectorAll('.mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    $('drop-title').textContent = t(m === 'world' ? 'drop_world' : 'drop_addon');
    $('mode-hint').textContent = t(m === 'world' ? 'hint_world' : 'hint_addon');
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
        prunePacks: $('opt-prune').checked,
        removeEditorTools: $('opt-tools').checked,
        removeSameAddon: $('opt-same').checked,
        includeHiddenItems: $('opt-hidden').checked,
        removeJunkLang: $('opt-junk').checked,
        // 固定写入简体中文：只在简体中文界面提供
        bakeZh: NS.UI.lang === 'zh_CN' && $('opt-bake').checked,
        bakeLang: NS.UI.lang === 'zh_CN' && $('opt-bake').checked ? state.bakeLang || null : null,
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
    const list = (items, fmt) => `<ul>${items.slice(0, 200).map(x => `<li>${fmt(x)}</li>`).join('')}${items.length > 200 ? `<li>${t('more', items.length)}</li>` : ''}</ul>`;
    let html = `<div class="summary-stats">
        <div class="stat"><b>${s.newKeys}</b><span>${t('s_extracted')}</span></div>
        <div class="stat"><b>${s.processedFiles}</b><span>${t(s.world ? 's_mod_records' : 's_mod_files')}</span></div>
        <div class="stat"><b>${s.untranslatable}</b><span>${t(s.world ? 's_manual' : 's_untr')}</span></div>
        <div class="stat"><b>${escapeHtml(s.sourceLang)}</b><span>${t('s_source')}</span></div>
    </div>`;
    if (s.structure) {
        if (s.createdRP) html += `<p class="summary-note">${t('n_struct_rp', `<code>${escapeHtml(s.createdRP)}</code>`)}</p>`;
        if (s.untranslatable) html += `<p class="summary-note">${t('n_untr_editor', s.untranslatable)}</p>`;
    } else if (s.world) {
        if (s.createdRP) html += `<p class="summary-note">${t('n_world_rp', `<code>${escapeHtml(s.createdRP)}</code>`)}</p>`;
        if (s.untranslatable) html += `<p class="summary-note">${t('n_untr_editor', s.untranslatable)}</p>`;
    } else if (s.createdRP) html += `<p class="summary-note">${t('n_created_rp', `<code>${escapeHtml(s.createdRP)}/</code>`)}</p>`;
    if (s.minVersion) {
        const mv = s.minVersion;
        const why = mv.basis.map(b => t('mv_' + b.k, escapeHtml(b.v), escapeHtml(b.mod || ''), escapeHtml(b.file || ''))).join('；');
        html += `<p class="summary-note">${t('n_minver', `<b>${escapeHtml(mv.label)}</b>`)}<br><small>${why}</small>${mv.beta ? `<br><small>⚠ ${t('mv_beta_warn', escapeHtml(mv.beta.mod), escapeHtml(mv.beta.label))}</small>` : ''}</p>`;
    }
    if (s.placeholders) html += `<p class="summary-note">${t('n_placeholders', s.placeholders)}</p>`;
    if (s.inputGroups) html += `<p class="summary-note">${t('n_input', s.inputGroups)}</p>`;
    if (untr.length && !s.world) {
        html += `<details><summary>${t('d_untr', untr.length)}</summary>${list(untr, u =>
            `<code>${escapeHtml(u.text)}</code> — ${escapeHtml(u.reason)}<br><small>${escapeHtml(u.file)} · ${escapeHtml(u.where)}</small>`)}</details>`;
    }
    if (s.warnings.length) {
        html += `<details><summary>${t('d_warn', s.warnings.length)}</summary>${list(s.warnings, w => escapeHtml(w))}</details>`;
    }
    if (s.missingRefs.length) {
        html += `<details><summary>${t('d_missing', s.missingRefs.length)}</summary>${list(s.missingRefs, ([k, f]) =>
            `<code>${escapeHtml(k)}</code><br><small>${escapeHtml(f)}</small>`)}</details>`;
    }
    state.lastSummaryRes = res;
    summaryEl.innerHTML = html;
    summaryEl.hidden = false;
}

/** 包版本号与最低可用版本：放在日志最后 */
function logVersions(s) {
    if (!NS.MinVersion || !s) return;
    for (const line of NS.MinVersion.describe(s.minVersion, s.packVersions)) log(line, /⚠/.test(line) ? 'warn' : 'info');
}

function worldSummary(session) {
    const lang = session.opt.sourceLang === 'auto' ? NS.detectSourceLang([...session.ctx.entries.values()].map(e => e.value)) : session.opt.sourceLang;
    return {
        world: true, newKeys: session.ctx.entries.size, processedFiles: session.records.filter(r => r.dirty).length,
        untranslatable: session.ctx.untranslatable.length, sourceLang: lang, warnings: session.ctx.warnings, missingRefs: [],
        createdRP: session.ctx.entries.size ? 'resource_packs/world_texts/' : null, packs: [], inputGroups: 0,
        minVersion: session.minVersion || null, packVersions: session.packVersions || [],
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
    mountEditor($('nbt-editor'), session, {
        onChange: () => { state.resultBlob = null; state.workbookBlob = null; },
        downloadCsv: (text, name) => downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${state.originalName}_${name || 'untranslatable'}.csv`),
    });
    setProgress(100, 'done_edit');
    log(`✅ 分析完成：自动转换 ${session.ctx.entries.size} 条，需人工处理 ${session.ctx.untranslatable.length} 处`);
    downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = false;
}

/** 存档 / 结构：按当前（含手动修改的）状态生成文件 */
async function buildWorldOutputs() {
    if (state.resultBlob && state.workbookBlob) return;
    if (!state.fs) {
        // 结构文件：输出 zip = 改好的 .mcstructure + 翻译资源包 .mcpack
        setProgress(90, 'generating');
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
        setProgress(100, 'done');
        return;
    }
    setProgress(90, 'writing_world');
    const res = await state.session.build(state.fs, (m, t) => log(m, t || 'info'));
    const outZip = await state.fs.toZip();
    state.resultBlob = await outZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const wb = new JSZip();
    for (const [name, content] of Object.entries(res.workbook)) wb.file(name, content);
    wb.file('process.log', state.logContent);
    state.workbookBlob = await wb.generateAsync({ type: 'blob' });
    log(`✅ 已生成 ${state.resultName}（手动修改 ${state.session.edits} 处）`);
    setProgress(100, 'done');
}

// ================================================================
//  主流程
// ================================================================

// 页面各脚本文件版本不一致（通常是浏览器缓存）时，提示强制刷新
const REQUIRED = ['ExtractContext', 'runPipeline', 'processScript', 'collectTranslationGroups', 'collectUiVarUsage', 'translateCommand', 'regexPhrases', 'runWorldPipeline', 'openStructure', 'convertStructureBytes', 'makeAddonStructureSession', 'makeAddonManualSession', 'mountWorldEditor', 'collectParamTexts', 'getLangBlacklist'];
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
    setProgress(0, 'loading');
    // 窄屏是单栏：上传后滚到进度区，免得用户以为没反应
    if (window.innerWidth < 960) document.querySelector('.col-output').scrollIntoView({ behavior: 'smooth', block: 'start' });

    log(`开始处理: ${file.name}（${(file.size / 1024).toFixed(1)} KB）  工具版本 ${($('app-version') || {}).textContent || ''}`);
    if (!checkVersion()) { setProgress(0, 'refresh'); downloadLogBtn.disabled = false; return; }

    try {
        if (ext === 'mcstructure') { await processStructure(file); return; }
        const zip = await JSZip.loadAsync(file);
        const inner = await extractInnerPacks(zip);
        if (inner) log(`解压了 ${inner} 个内层包`);

        const fs = new ZipFS(zip);
        log(`共 ${fs.list().length} 个文件`);
        setProgress(5, 'analyzing');

        const options = {
            ...readOptions(),
            baseName: state.originalName,
            onProgress: (r, p) => setProgress(5 + Math.floor(r * 75), 'processing', p.split('/').pop()),
        };
        // 压缩包里有 level.dat + db/ → 世界存档
        const isWorld = fs.list().some(p => /(^|\/)level\.dat$/.test(p)) && fs.list().some(p => /(^|\/)db\/CURRENT$/.test(p));
        if (isWorld && mode !== 'world') { setMode('world'); log('检测到世界存档，已切换到“世界存档”模式'); }
        if (!isWorld && mode === 'world') { setMode('addon'); log('这不是世界存档，已切换到“附加包”模式'); }
        state.session = null;
        state.addonSession = null; state.addonFs = null; state.editorArgs = null; state.lastSummaryRes = null;
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
            mountEditor($('nbt-editor'), session, {
                onChange: () => { state.resultBlob = null; state.workbookBlob = null; },
                downloadCsv: (text, name) => downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${state.originalName}_${name || 'untranslatable'}.csv`),
            });
            setProgress(100, 'done_edit');
            logVersions(worldSummary(session));
            log(`✅ 分析完成：自动转换 ${session.ctx.entries.size} 条，需人工处理 ${session.ctx.untranslatable.length} 处`);
            downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = false;
            return;
        }
        const res = await NS.runPipeline(fs, options, (m, t) => log(m, t || 'info'));
        const s = res.summary;

        // “含换行，已写成 \n” 一类提示往往有几百条：页面上只显示一行汇总，明细放进下载的日志
        const nlWarn = s.warnings.filter(w => / 含换行，已写成 \\n$/.test(w));
        for (const w of s.warnings) if (!nlWarn.includes(w)) log(`⚠ ${w}`, 'warn');
        if (nlWarn.length) {
            log(`⚠ ${nlWarn.length} 处文字含换行，已写成 \\n（明细见“下载日志”）`, 'warn');
            for (const w of nlWarn) { const line = `[${new Date().toLocaleTimeString()}] ⚠ ${w}`; state.logContent += (NS.LogI18n ? NS.LogI18n.tr(line, NS.UI.lang) : line) + '\n'; }
        }
        logMany(res.ctx.untranslatable, u => `[无法本地化] ${u.file} ${u.where}: ${u.text}（${u.reason}）`);
        log(`新增翻译键 ${s.newKeys} 条，包名/描述 ${s.packKeys} 条，修改文件 ${s.processedFiles} 个`);

        // 需人工翻译的文字（结构里的名字、战利品表 set_name、脚本 nameTag……）：显示编辑器，可直接改或导入填好的翻译表，下载时写回
        if (res.manualSession && res.manualSession.ctx.untranslatable.length) {
            state.addonSession = res.manualSession;
            state.addonFs = fs;
            mountEditor($('nbt-editor'), res.manualSession, {
                onChange: () => { state.resultBlob = null; },
                downloadCsv: (text, name) => downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${state.originalName}_${name || 'untranslatable'}.csv`),
            });
            $('nbt-editor').hidden = false;
            log(`有 ${res.ctx.untranslatable.length} 处需人工翻译：可在下方编辑器修改，或导出待翻译表，在 translation 列填好后导入；下载时写回附加包`);
        }

        setProgress(85, 'packing');
        const outZip = await fs.toZip();
        state.resultBlob = await outZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const multiPack = s.packs.length > 1 || s.restructured;
        const outExt = ext === 'mcpack' && !multiPack ? 'mcpack' : 'mcaddon';
        state.resultName = `${state.originalName}_i18n.${outExt}`;

        logVersions(s);
        // 翻译表：CSV（Excel 可直接打开）+ 源语言 lang + 报告
        const wb = new JSZip();
        for (const [name, content] of Object.entries(res.workbook)) wb.file(name, content);
        wb.file('process.log', state.logContent);
        state.workbookBlob = await wb.generateAsync({ type: 'blob' });

        renderSummary(res);
        setProgress(100, 'done');
        log(`✅ 处理完成: ${state.resultName}`);
        downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = false;
    } catch (e) {
        log(`❌ 错误: ${e.message}`, 'error');
        setProgress(0, 'failed');
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
    setProgress(90, 'writing_edits');
    const r = await state.addonSession.applyTo(state.addonFs);
    const outZip = await state.addonFs.toZip();
    state.resultBlob = await outZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    log(`✅ 已重新打包（手动修改 ${state.addonSession.edits} 处，写回结构 ${r.structures} 个、文件 ${r.files} 个）`);
    if (r.renamed) log(`[实体名] 命令和脚本里按名字找实体的地方同步修改 ${r.renamed} 处`);
    if (r.missed) log(`⚠ 有 ${r.missed} 条没有在文件里找到原文（可能已被转换改写），未写回`, 'warn');
    setProgress(100, 'done');
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
    toggleLogBtn.textContent = t(logEl.classList.contains('collapsed') ? 'expand' : 'collapse');
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

// ================================================================
//  界面语言 · 访问计数
// ================================================================

// 底部版本号：取 app.js 的 ?v=，和发布版本保持一致（不用再手动改）
(function initAppVersion() {
    const sc = document.querySelector('script[src*="app.js?v="]');
    const m = sc && /[?&]v=([^&]+)/.exec(sc.getAttribute('src'));
    if (m && $('app-version')) $('app-version').textContent = 'v' + m[1];
})();

(function initUiLang() {
    const sel = $('ui-lang');
    for (const [code, name] of NS.UI.LANGS) sel.append(new Option(name, code));
    sel.value = NS.UI.lang;
    sel.addEventListener('change', () => NS.UI.set(sel.value));
    const bakeWrap = $('bake-wrap');
    const bakeFile = $('opt-bake-file');
    if (bakeFile) bakeFile.addEventListener('change', async () => {
        const f = bakeFile.files && bakeFile.files[0];
        state.bakeLang = null;
        if (f) {
            try {
                state.bakeLang = NS.parseLang(await f.text());
                $('opt-bake-info').textContent = `已读取 ${state.bakeLang.size} 条译文`;
                $('opt-bake').checked = true;
            } catch (e) { $('opt-bake-info').textContent = `读取失败：${e.message}`; }
        }
    });
    const refresh = () => {
        if (bakeWrap) bakeWrap.hidden = NS.UI.lang !== 'zh_CN';
        $('footer-by').innerHTML = escapeHtml(NS.UI.t('footer_by', '\u0000')).replace('\u0000', '<a href="https://github.com/zanesu154-rgb" target="_blank" rel="noopener">栈主</a>');
        setMode(mode);
        progressText.textContent = NS.UI.t(...progressKey);
        toggleLogBtn.textContent = NS.UI.t(logEl.classList.contains('collapsed') ? 'expand' : 'collapse');
        if (state.lastSummaryRes) renderSummary(state.lastSummaryRes);
        if (state.editorArgs) NS.mountWorldEditor(...state.editorArgs);
    };
    NS.UI.onChange(refresh);
    NS.UI.apply();
    refresh();
})();

(function initCounter() {
    // 不蒜子填好数字后，画成七段数码管；加载失败（被拦截、离线）时保持隐藏
    const box = $('visit-counter'), pv = $('busuanzi_value_page_pv'), uv = $('busuanzi_value_site_uv');
    //            a  b  c  d  e  f  g
    const SEG = { 0: '1111110', 1: '0110000', 2: '1101101', 3: '1111001', 4: '0110011', 5: '1011011', 6: '1011111', 7: '1110000', 8: '1111111', 9: '1111011' };
    const POLY = [
        '3,1 17,1 14,4 6,4', '18,2 18,16 15,14 15,5', '18,18 18,32 15,29 15,20', '3,33 17,33 14,30 6,30',
        '2,18 5,20 5,29 2,32', '2,2 5,5 5,14 2,16', '3,17 6,15 14,15 17,17 14,19 6,19',
    ];
    const digitSvg = (d) => {
        const on = SEG[d] || '0000000';
        return `<svg class="led-digit" viewBox="0 0 20 34" aria-hidden="true">${POLY.map((p, i) => `<polygon points="${p}" class="${on[i] === '1' ? 'on' : 'off'}"/>`).join('')}</svg>`;
    };
    // 只画实际位数，数字在各自区域里居中（位数变化时自动居中）
    const draw = (el, text) => {
        const n = String(text).replace(/\D/g, '') || '0';
        el.innerHTML = [...n].map(ch => digitSvg(+ch)).join('');
        el.setAttribute('aria-label', n);
    };
    let tries = 0;
    const timer = setInterval(() => {
        if (/\d/.test(pv.textContent)) {
            draw($('led-pv'), pv.textContent);
            draw($('led-uv'), uv.textContent);
            box.hidden = false;
            clearInterval(timer);
        } else if (++tries > 30) clearInterval(timer);
    }, 500);
})();

// ================================================================
//  赞助：简体中文显示赞赏码，其他语言显示 Buy me a coffee
// ================================================================
(() => {
    const SPONSOR_ZH = 'https://raw.githubusercontent.com/zanesu154-rgb/My-sponsor-picture/refs/heads/main/%E8%B5%9E%E8%B5%8F%E7%A0%81.png';
    const SPONSOR_EN = 'https://raw.githubusercontent.com/zanesu154-rgb/My-sponsor-picture/refs/heads/main/Buy%20me%20a%20coffee.jpg';
    const btn = $('sponsor-btn'), dlg = $('sponsor-dialog'), img = $('sponsor-img');
    if (!btn || !dlg) return;
    btn.addEventListener('click', () => {
        const zh = NS.UI.lang === 'zh_CN';
        const src = zh ? SPONSOR_ZH : SPONSOR_EN;
        if (img.getAttribute('src') !== src) img.src = src;
        img.alt = t('sponsor');
        if (typeof dlg.showModal === 'function') dlg.showModal(); else window.open(src, '_blank', 'noopener');
    });
    // 点遮罩关闭
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
})();
