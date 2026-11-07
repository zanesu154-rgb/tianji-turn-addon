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

function log(msg, type = 'info') {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.logContent += line + '\n';
    if (!logAutoExpanded) {
        logEl.classList.remove('collapsed');
        toggleLogBtn.textContent = '收起';
        logAutoExpanded = true;
    }
    const span = document.createElement('span');
    span.className = `log-${type}`;
    span.textContent = line + '\n';
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
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
        return typeof v === 'string' ? v : v.async('string');
    }
    writeText(p, s) { this.entries.set(p, s); }
    move(a, b) {
        const v = this.entries.get(a);
        this.entries.delete(a);
        this.entries.set(b, v);
    }
    async toZip() {
        const z = new JSZip();
        for (const [p, v] of this.entries) {
            z.file(p, typeof v === 'string' ? v : await v.async('uint8array'));
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
        fillMissing: $('opt-fill').checked,
        placeholderNames: $('opt-placeholder').checked,
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
        <div class="stat"><b>${s.processedFiles}</b><span>修改的文件</span></div>
        <div class="stat"><b>${s.untranslatable}</b><span>无法本地化</span></div>
        <div class="stat"><b>${escapeHtml(s.sourceLang)}</b><span>原文语言</span></div>
    </div>`;
    if (s.createdRP) html += `<p class="summary-note">附加包没有资源包，已新建 <code>${escapeHtml(s.createdRP)}/</code> 存放翻译，并让行为包依赖它。</p>`;
    if (s.placeholders) html += `<p class="summary-note">${s.placeholders} 个物品/方块/实体原本没有名称，已按 ID 生成英文占位名，请在 lang 中确认。</p>`;
    if (untr.length) {
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

// ================================================================
//  主流程
// ================================================================

async function processFile(file) {
    const ext = (file.name.match(/\.(mcaddon|mcpack|zip)$/i) || [, 'mcaddon'])[1].toLowerCase();
    state.originalName = file.name.replace(/\.(mcaddon|mcpack|zip)$/i, '');
    state.logContent = '';
    state.resultBlob = state.workbookBlob = null;
    logEl.innerHTML = '';
    logAutoExpanded = false;
    summaryEl.hidden = true;
    downloadLogBtn.disabled = downloadResultBtn.disabled = downloadWorkbookBtn.disabled = true;
    setProgress(0, '加载中...');

    log(`开始处理: ${file.name}（${(file.size / 1024).toFixed(1)} KB）`);

    try {
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
        const res = await NS.runPipeline(fs, options, (m, t) => log(m, t || 'info'));
        const s = res.summary;

        for (const w of s.warnings) log(`⚠ ${w}`, 'warn');
        for (const u of res.ctx.untranslatable) log(`[无法本地化] ${u.file} ${u.where}: ${u.text}（${u.reason}）`, 'warn');
        log(`新增翻译键 ${s.newKeys} 条，包名/描述 ${s.packKeys} 条，修改文件 ${s.processedFiles} 个`);

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

downloadResultBtn.addEventListener('click', () => {
    if (state.resultBlob) downloadBlob(state.resultBlob, state.resultName);
});

downloadWorkbookBtn.addEventListener('click', () => {
    if (state.workbookBlob) downloadBlob(state.workbookBlob, `${state.originalName}_translation.zip`);
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
