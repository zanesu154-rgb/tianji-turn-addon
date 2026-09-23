/* ================================================================
 *  栈主的附加包汉化工具
 *  纯前端，浏览器内处理 .mcaddon
 * ================================================================ */

// ---- 全局状态 ----
const state = {
    originalFile: null,
    originalName: '',
    resultBlob: null,
    resultName: '',
    logContent: '',
    progress: 0,
};

// ---- DOM ----
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const downloadLogBtn = document.getElementById('download-log');
const downloadResultBtn = document.getElementById('download-result');
const logEl = document.getElementById('log');

// ================================================================
//  工具函数
// ================================================================

function log(msg, type = 'info') {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.logContent += line + '\n';

    logEl.classList.add('visible');
    const span = document.createElement('span');
    span.className = `log-${type}`;
    span.textContent = line + '\n';
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(percent, text) {
    state.progress = percent;
    progressFill.style.width = `${percent}%`;
    if (text) progressText.textContent = text;
}

function isAlreadyKey(text) {
    if (typeof text !== 'string') return false;
    if (text.includes(' ')) return false;
    if (/[\u4e00-\u9fff]/.test(text)) return false;
    return /^[a-z0-9_:]+(\.[a-z0-9_:]+)+$/.test(text);
}

function escapeLangValue(value) {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

function makeUniqueKey(baseKey, usedKeys) {
    let key = baseKey;
    let suffix = 1;
    while (usedKeys.has(key)) {
        key = `${baseKey}_${suffix}`;
        suffix++;
    }
    usedKeys.add(key);
    return key;
}

// ================================================================
//  处理上下文
// ================================================================

class ProcessContext {
    constructor() {
        this.langEntries = [];      // [(key, value)]
        this.usedKeys = new Set();
        this.referencedKeys = new Set();
        this.logger = {
            logKey: (k, v, f) => log(`  键: ${k}=${v}`, 'info'),
            logProcessed: (f, type) => log(`[${type}] ${f}`, 'info'),
            logSkipped: (f, reason) => log(`[跳过] ${f}: ${reason}`, 'warn'),
            logDeobfuscated: (f, type) => log(`[反混淆-${type}] ${f}`, 'info'),
        };
    }

    addKey(key, value, filepath) {
        this.langEntries.push([key, value]);
        this.logger.logKey(key, value, filepath);
    }
}

// ================================================================
//  核心：_replace_field
// ================================================================

/**
 * 替换 container[fieldName]。
 * useRawtext=false → 纯字符串
 * useRawtext=true  → RawText
 */
function replaceField(container, fieldName, baseKey, ctx, filepath, useRawtext = false) {
    if (!container || typeof container !== 'object') return false;

    const value = container[fieldName];

    // 已是 rawtext → 跳过
    if (value && typeof value === 'object' && 'rawtext' in value) {
        const raw = value.rawtext || [];
        if (raw[0] && raw[0].translate) {
            ctx.referencedKeys.add(raw[0].translate);
        }
        return false;
    }

    let current, isStringForm;

    if (typeof value === 'string') {
        if (isAlreadyKey(value)) {
            ctx.referencedKeys.add(value);
            return false;
        }
        current = value;
        isStringForm = true;
    } else if (value && typeof value === 'object' && 'value' in value) {
        if (typeof value.value !== 'string') return false;
        if (isAlreadyKey(value.value)) {
            ctx.referencedKeys.add(value.value);
            return false;
        }
        current = value.value;
        isStringForm = false;
    } else {
        return false;
    }

    const newKey = makeUniqueKey(baseKey, ctx.usedKeys);
    ctx.addKey(newKey, escapeLangValue(current), filepath);

    let newValue;
    if (useRawtext && isStringForm) {
        newValue = { rawtext: [{ translate: newKey }] };
    } else {
        newValue = newKey;
    }

    if (isStringForm) {
        container[fieldName] = newValue;
    } else {
        value.value = newValue;
    }

    return true;
}

// ================================================================
//  处理器：物品
// ================================================================

function processItem(json, filepath, ctx) {
    const item = json['minecraft:item'];
    if (!item) return false;

    const identifier = item.description?.identifier;
    if (!identifier) return false;

    const components = item.components || {};
    return replaceField(
        components, 'minecraft:display_name',
        `item.${identifier}.name`, ctx, filepath, false
    );
}

// ================================================================
//  处理器：方块
// ================================================================

function processBlock(json, filepath, ctx) {
    const block = json['minecraft:block'];
    if (!block) return false;

    const identifier = block.description?.identifier;
    if (!identifier) return false;

    const components = block.components || {};
    return replaceField(
        components, 'minecraft:display_name',
        `tile.${identifier}.name`, ctx, filepath, false
    );
}

// ================================================================
//  处理器：实体
// ================================================================

function processEntity(json, filepath, ctx) {
    const entity = json['minecraft:entity'];
    if (!entity) return false;

    const identifier = entity.description?.identifier;
    if (!identifier) return false;

    let replaced = false;
    const baseKey = `entity.${identifier}.name`;

    const components = entity.components || {};

    // boss.name
    const boss = components['minecraft:boss'];
    if (boss && typeof boss === 'object') {
        if (replaceField(boss, 'name', baseKey, ctx, filepath, false)) replaced = true;
    }

    // component_groups 里的 boss
    const groups = entity.component_groups || {};
    for (const groupData of Object.values(groups)) {
        if (!groupData || typeof groupData !== 'object') continue;
        const b = groupData['minecraft:boss'];
        if (b && typeof b === 'object') {
            if (replaceField(b, 'name', baseKey, ctx, filepath, false)) replaced = true;
        }
    }

    // nameable.name
    const nameable = components['minecraft:nameable'];
    if (nameable && typeof nameable === 'object') {
        if (replaceField(nameable, 'name', baseKey, ctx, filepath, false)) replaced = true;
    }

    // interact_text
    const interact = components['minecraft:interact'];
    if (Array.isArray(interact)) {
        let counter = 0;
        for (const item of interact) {
            if (!item || typeof item !== 'object') continue;
            if (!('interact_text' in item)) continue;
            const key = `entity.${identifier}.interact_${counter}`;
            counter++;
            if (replaceField(item, 'interact_text', key, ctx, filepath, false)) replaced = true;
        }
    }

    // trade_table.display_name
    const tradeTable = components['minecraft:trade_table'];
    if (tradeTable && typeof tradeTable === 'object') {
        if (replaceField(tradeTable, 'display_name', `trade.${identifier}.name`, ctx, filepath, false)) {
            replaced = true;
        }
    }

    return replaced;
}

// ================================================================
//  处理器：manifest
// ================================================================

function processManifest(json, filepath, ctx) {
    const header = json.header;
    if (!header || typeof header !== 'object') return false;

    let replaced = false;

    if (typeof header.name === 'string' && !isAlreadyKey(header.name)) {
        if (!ctx.usedKeys.has('pack.name')) {
            ctx.addKey('pack.name', escapeLangValue(header.name), filepath);
            ctx.usedKeys.add('pack.name');
        }
        header.name = 'pack.name';
        replaced = true;
    }

    if (typeof header.description === 'string' && !isAlreadyKey(header.description)) {
        if (!ctx.usedKeys.has('pack.description')) {
            ctx.addKey('pack.description', escapeLangValue(header.description), filepath);
            ctx.usedKeys.add('pack.description');
        }
        header.description = 'pack.description';
        replaced = true;
    }

    return replaced;
}

// ================================================================
//  文件路径判断
// ================================================================

function matchDir(rel, ...dirs) {
    const parts = rel.replace(/\\/g, '/').split('/');
    for (const d of dirs) {
        if (parts.includes(d)) return true;
    }
    return false;
}

function shouldSkip(filename, rel) {
    if (filename.startsWith('._')) return true;
    if (['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(filename)) return true;
    const skipDirs = ['__MACOSX', 'node_modules', '.git', '.vscode'];
    const parts = rel.replace(/\\/g, '/').split('/');
    for (const p of parts) {
        if (skipDirs.includes(p)) return true;
    }
    return false;
}

// ================================================================
//  反混淆
// ================================================================

function stripJsonComments(content) {
    let result = '';
    let i = 0;
    const n = content.length;
    let inLineComment = false;
    let inBlockComment = false;
    let inString = false;
    let stringChar = null;

    while (i < n) {
        const c = content[i];

        if (inLineComment) {
            if (c === '\n') {
                inLineComment = false;
                result += c;
            }
            i++;
            continue;
        }

        if (inBlockComment) {
            if (c === '*' && i + 1 < n && content[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            if (c === '\\' && i + 1 < n) {
                result += c + content[i + 1];
                i += 2;
                continue;
            }
            if (c === stringChar) {
                inString = false;
                stringChar = null;
            }
            result += c;
            i++;
            continue;
        }

        if (c === '/' && i + 1 < n) {
            if (content[i + 1] === '/') {
                inLineComment = true;
                i += 2;
                continue;
            }
            if (content[i + 1] === '*') {
                inBlockComment = true;
                i += 2;
                continue;
            }
        }

        if (c === '"' || c === "'") {
            inString = true;
            stringChar = c;
            result += c;
            i++;
            continue;
        }

        result += c;
        i++;
    }

    return result;
}

function decodeUnicode(text) {
    const special = {
        '\n': '\\n', '\r': '\\r', '\t': '\\t',
        '\\': '\\\\', '"': '\\"',
    };

    const replacer = (match, hex) => {
        const code = parseInt(hex, 16);
        const ch = String.fromCharCode(code);
        return special[ch] || ch;
    };

    text = text.replace(/\\u\{([0-9a-fA-F]+)\}/g, replacer);
    text = text.replace(/\\u([0-9a-fA-F]{4})/g, replacer);
    text = text.replace(/\\x([0-9a-fA-F]{2})/g, replacer);
    return text;
}

function deobfuscateJson(content) {
    const cleaned = stripJsonComments(content);
    try {
        const data = JSON.parse(cleaned);
        return { data, changed: cleaned !== content };
    } catch (e) {
        return { data: null, changed: false };
    }
}

// ================================================================
//  主流程
// ================================================================

async function processFile(file) {
    state.originalFile = file;
    state.originalName = file.name.replace(/\.(mcaddon|zip)$/i, '');
    state.logContent = '';
    state.resultBlob = null;
    state.resultName = '';
    logEl.innerHTML = '';
    logEl.classList.remove('visible');
    downloadLogBtn.disabled = true;
    downloadResultBtn.disabled = true;
    setProgress(0, '加载中...');

    log(`开始处理: ${file.name}`);
    log(`文件大小: ${(file.size / 1024).toFixed(1)} KB`);

    try {
        // ---- 1. 读取 zip ----
        setProgress(5, '读取压缩包...');
        const zip = await JSZip.loadAsync(file);

        const allFiles = Object.keys(zip.files).filter(name => !zip.files[name].dir);
        log(`共 ${allFiles.length} 个文件`);

        // ---- 2. 反混淆 + 扫描 ----
        const ctx = new ProcessContext();
        const updatedFiles = {};   // {path: content}
        let processedCount = 0;
        let deobCount = 0;

        // 找到包根目录（含 manifest.json 的）
        const packRoots = [];
        for (const name of allFiles) {
            if (name.endsWith('/manifest.json') || name === 'manifest.json') {
                const dir = name.substring(0, name.lastIndexOf('/'));
                packRoots.push(dir);
            }
        }
        log(`找到 ${packRoots.length} 个包`);

        for (let i = 0; i < allFiles.length; i++) {
            const name = allFiles[i];
            const percent = 10 + Math.floor((i / allFiles.length) * 70);
            setProgress(percent, `处理: ${name.split('/').pop()}`);

            const filename = name.split('/').pop();
            const rel = name.substring(0, name.lastIndexOf('/')).toLowerCase();

            if (shouldSkip(filename, rel)) continue;
            if (!filename.toLowerCase().endsWith('.json')) continue;

            let content;
            try {
                content = await zip.files[name].async('string');
            } catch (e) {
                log(`[跳过] ${name}: 读取失败`, 'warn');
                continue;
            }

            // 反混淆
            const { data, changed } = deobfuscateJson(content);
            if (changed) {
                deobCount++;
                log(`[反混淆] ${name}`, 'info');
            }
            if (!data) {
                log(`[跳过] ${name}: 解析失败`, 'warn');
                continue;
            }

            // 扫描
            let replaced = false;
            const filenameLower = filename.toLowerCase();
            if (filenameLower === 'manifest.json') {
                replaced = processManifest(data, name, ctx);
            } else if (matchDir(rel, 'items', 'item', 'item_definitions')) {
                replaced = processItem(data, name, ctx);
            } else if (matchDir(rel, 'blocks', 'block', 'block_definitions')) {
                replaced = processBlock(data, name, ctx);
            } else if (matchDir(rel, 'entities', 'entity')) {
                replaced = processEntity(data, name, ctx);
            }

            if (replaced || changed) {
                updatedFiles[name] = JSON.stringify(data, null, 2);
                if (replaced) processedCount++;
            }
        }

        log(`反混淆: ${deobCount} 个文件`);
        log(`处理: ${processedCount} 个文件`);
        log(`生成键: ${ctx.langEntries.length} 条`);

        // ---- 3. 写入更新后的文件 ----
        setProgress(80, '写入文件...');
        for (const [path, content] of Object.entries(updatedFiles)) {
            zip.file(path, content);
        }

        // ---- 4. 生成 lang ----
        setProgress(85, '生成 lang...');
        if (ctx.langEntries.length > 0) {
            const langContent = ctx.langEntries.map(([k, v]) => `${k}=${v}`).join('\n');

            // 找 pack roots，写到 texts/zh_CN.lang
            for (const root of packRoots) {
                const textsDir = root ? `${root}/texts` : 'texts';
                zip.file(`${textsDir}/zh_CN.lang`, langContent);
                log(`[lang] 写入 ${textsDir}/zh_CN.lang`, 'info');

                // 更新 languages.json
                const langJsonPath = `${textsDir}/languages.json`;
                let langs = ['en_US'];
                const existing = zip.file(langJsonPath);
                if (existing) {
                    try {
                        const content = await existing.async('string');
                        langs = JSON.parse(content);
                        if (!Array.isArray(langs)) langs = ['en_US'];
                    } catch (e) {}
                }
                if (!langs.includes('zh_CN')) {
                    langs.push('zh_CN');
                    zip.file(langJsonPath, JSON.stringify(langs, null, 2));
                    log(`[languages.json] 添加 zh_CN`, 'info');
                }
            }
        }

        // ---- 5. 打包 ----
        setProgress(90, '打包中...');
        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });

        state.resultBlob = blob;
        state.resultName = `${state.originalName}_zh_modified.mcaddon`;

        setProgress(100, '完成！');
        log(`✅ 处理完成，输出: ${state.resultName}`, 'info');

        downloadLogBtn.disabled = false;
        downloadResultBtn.disabled = false;

    } catch (e) {
        log(`❌ 错误: ${e.message}`, 'error');
        setProgress(0, '处理失败');
        console.error(e);
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
    URL.revokeObjectURL(url);
}

downloadResultBtn.addEventListener('click', () => {
    if (state.resultBlob) {
        downloadBlob(state.resultBlob, state.resultName);
        log(`已下载: ${state.resultName}`);
    }
});

downloadLogBtn.addEventListener('click', () => {
    if (state.logContent) {
        const blob = new Blob([state.logContent], { type: 'text/plain;charset=utf-8' });
        downloadBlob(blob, `${state.originalName}_process.log`);
        log(`已下载日志`);
    }
});

// ================================================================
//  文件选择
// ================================================================

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await processFile(file);
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) await processFile(file);
});