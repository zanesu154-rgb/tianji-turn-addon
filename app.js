/* ================================================================
 *  栈主的附加包汉化工具 - 第二版 + JS 处理
 * ================================================================ */

const state = {
    originalFile: null,
    originalName: '',
    resultBlob: null,
    resultName: '',
    logContent: '',
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

function parseLang(content) {
    const result = {};
    if (!content) return result;
    for (const line of content.split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        result[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
    }
    return result;
}

// ================================================================
//  上下文
// ================================================================

class ProcessContext {
    constructor() {
        this.langEntries = [];
        this.usedKeys = new Set();
        this.referencedKeys = new Set();
    }

    addKey(key, value, filepath) {
        this.langEntries.push([key, value]);
    }
}

// ================================================================
//  核心：replaceField
// ================================================================

function replaceField(container, fieldName, baseKey, ctx, filepath, useRawtext = false) {
    if (!container || typeof container !== 'object') return false;

    const value = container[fieldName];

    if (value && typeof value === 'object' && 'rawtext' in value) {
        const raw = value.rawtext || [];
        if (raw[0] && raw[0].translate) ctx.referencedKeys.add(raw[0].translate);
        return false;
    }

    let current, isStringForm;
    if (typeof value === 'string') {
        if (isAlreadyKey(value)) { ctx.referencedKeys.add(value); return false; }
        current = value;
        isStringForm = true;
    } else if (value && typeof value === 'object' && 'value' in value) {
        if (typeof value.value !== 'string') return false;
        if (isAlreadyKey(value.value)) { ctx.referencedKeys.add(value.value); return false; }
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

    if (isStringForm) container[fieldName] = newValue;
    else value.value = newValue;

    return true;
}

// ================================================================
//  命令处理
// ================================================================

const SELECTOR = '@[a-z](?:\\[[^\\]]*\\])?';

function translateCommand(cmd, identifier, ctx, filepath) {
    let replaced = false;
    const titleRe = new RegExp(
        `(title\\s+${SELECTOR}\\s+(?:actionbar|title|subtitle)\\s+)(.+?)(?=;|$)`,
        's'
    );

    const m = titleRe.exec(cmd);
    if (m) {
        const text = m[2].trim();
        if (!isAlreadyKey(text) && !text.startsWith('{')) {
            const key = makeUniqueKey(`entity.${identifier}.message`, ctx.usedKeys);
            const escaped = escapeLangValue(text);
            ctx.addKey(key, escaped, filepath);

            const before = cmd.substring(0, m.index);
            const after = cmd.substring(m.index + m[0].length);
            const prefix = m[1].replace('title ', 'titleraw ');
            const replacement = `${prefix}{"rawtext":[{"translate":"${key}"}]}`;
            cmd = `${before}${replacement}${after}`;
            replaced = true;
        }
    }

    cmd = cmd.replace(/("text"\s*:\s*")([^"]+)(")/g, (match, p1, text, p3) => {
        if (isAlreadyKey(text)) { ctx.referencedKeys.add(text); return match; }
        const key = makeUniqueKey(`entity.${identifier}.message`, ctx.usedKeys);
        const escaped = escapeLangValue(text);
        ctx.addKey(key, escaped, filepath);
        replaced = true;
        return `"translate":"${key}"`;
    });

    return [cmd, replaced];
}

function scanCommands(obj, identifier, ctx, filepath) {
    let replaced = false;

    function scan(node) {
        if (Array.isArray(node)) { for (const item of node) scan(item); return; }
        if (!node || typeof node !== 'object') return;

        for (const [key, value] of Object.entries(node)) {
            if (key === 'command') {
                if (typeof value === 'string') {
                    const [newCmd, changed] = translateCommand(value, identifier, ctx, filepath);
                    if (changed) { node[key] = newCmd; replaced = true; }
                } else if (Array.isArray(value)) {
                    const newList = [];
                    let changed = false;
                    for (const item of value) {
                        if (typeof item === 'string') {
                            const [newCmd, c] = translateCommand(item, identifier, ctx, filepath);
                            if (c) changed = true;
                            newList.push(newCmd);
                        } else newList.push(item);
                    }
                    if (changed) { node[key] = newList; replaced = true; }
                }
            } else {
                scan(value);
            }
        }
    }

    scan(obj);
    return replaced;
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
    return replaceField(components, 'minecraft:display_name',
        `item.${identifier}.name`, ctx, filepath, false);
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
    return replaceField(components, 'minecraft:display_name',
        `tile.${identifier}.name`, ctx, filepath, false);
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

    const boss = components['minecraft:boss'];
    if (boss && typeof boss === 'object') {
        if (replaceField(boss, 'name', baseKey, ctx, filepath, false)) replaced = true;
    }

    for (const groupData of Object.values(entity.component_groups || {})) {
        if (!groupData || typeof groupData !== 'object') continue;
        const b = groupData['minecraft:boss'];
        if (b && typeof b === 'object') {
            if (replaceField(b, 'name', baseKey, ctx, filepath, false)) replaced = true;
        }
    }

    const nameable = components['minecraft:nameable'];
    if (nameable && typeof nameable === 'object') {
        if (replaceField(nameable, 'name', baseKey, ctx, filepath, false)) replaced = true;
    }

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

    const tradeTable = components['minecraft:trade_table'];
    if (tradeTable && typeof tradeTable === 'object') {
        if (replaceField(tradeTable, 'display_name',
            `trade.${identifier}.name`, ctx, filepath, false)) replaced = true;
    }

    if (scanCommands(json, identifier, ctx, filepath)) replaced = true;
    return replaced;
}

// ================================================================
//  处理器：对话
// ================================================================

function processDialogue(json, filepath, ctx) {
    const dialogue = json['minecraft:npc_dialogue'];
    if (!dialogue) return false;
    const scenes = dialogue.scenes;
    if (!Array.isArray(scenes)) return false;

    let replaced = false;
    const fileBase = filepath.split('/').pop().replace('.json', '');

    for (const scene of scenes) {
        if (!scene || typeof scene !== 'object') continue;
        const sceneTag = scene.scene_tag || fileBase;

        if (replaceField(scene, 'npc_name', `dialogue.${sceneTag}.npc_name`,
            ctx, filepath, true)) replaced = true;
        if (replaceField(scene, 'text', `dialogue.${sceneTag}.text`,
            ctx, filepath, true)) replaced = true;

        const buttons = scene.buttons || [];
        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            if (!button || typeof button !== 'object') continue;

            if (replaceField(button, 'name', `dialogue.${sceneTag}.button_${i}`,
                ctx, filepath, true)) replaced = true;

            if (Array.isArray(button.commands)) {
                const newList = [];
                let changed = false;
                for (const item of button.commands) {
                    if (typeof item === 'string') {
                        const [newCmd, c] = translateCommand(item, sceneTag, ctx, filepath);
                        if (c) changed = true;
                        newList.push(newCmd);
                    } else newList.push(item);
                }
                if (changed) { button.commands = newList; replaced = true; }
            }
        }

        if (Array.isArray(scene.on_close_commands)) {
            const newList = [];
            let changed = false;
            for (const item of scene.on_close_commands) {
                if (typeof item === 'string') {
                    const [newCmd, c] = translateCommand(item, sceneTag, ctx, filepath);
                    if (c) changed = true;
                    newList.push(newCmd);
                } else newList.push(item);
            }
            if (changed) { scene.on_close_commands = newList; replaced = true; }
        }
    }

    return replaced;
}

// ================================================================
//  处理器：交易
// ================================================================

function processLore(obj, fileBase, ctx, filepath) {
    const lore = obj.lore;
    if (!Array.isArray(lore)) return false;

    let replaced = false;
    let counter = 0;

    for (let i = 0; i < lore.length; i++) {
        const item = lore[i];

        if (typeof item === 'string') {
            if (!item.trim() || isAlreadyKey(item)) continue;
            const key = makeUniqueKey(`trade.${fileBase}.lore_${counter}`, ctx.usedKeys);
            counter++;
            ctx.addKey(key, escapeLangValue(item), filepath);
            lore[i] = key;
            replaced = true;
        } else if (item && typeof item === 'object' && 'rawtext' in item) {
            const raw = item.rawtext || [];
            for (let j = 0; j < raw.length; j++) {
                const node = raw[j];
                if (!node || typeof node !== 'object') continue;
                if ('translate' in node) { ctx.referencedKeys.add(node.translate); continue; }
                if (typeof node.text === 'string') {
                    const text = node.text;
                    if (!text.trim() || isAlreadyKey(text)) continue;
                    const key = makeUniqueKey(`trade.${fileBase}.lore_${counter}`, ctx.usedKeys);
                    counter++;
                    ctx.addKey(key, escapeLangValue(text), filepath);
                    const newNode = { translate: key };
                    if (node.with) newNode.with = node.with;
                    raw[j] = newNode;
                    replaced = true;
                }
            }
        }
    }

    return replaced;
}

function processTrading(json, filepath, ctx) {
    let replaced = false;
    const fileBase = filepath.split('/').pop().replace('.json', '');

    const tradeTable = json['minecraft:trade_table'];
    if (tradeTable && typeof tradeTable === 'object') {
        if (replaceField(tradeTable, 'display_name',
            `trade.${fileBase}.name`, ctx, filepath, false)) replaced = true;
    }

    function scan(obj) {
        if (Array.isArray(obj)) { for (const item of obj) scan(item); return; }
        if (!obj || typeof obj !== 'object') return;

        const func = obj.function;
        if (func === 'set_name') {
            if (replaceField(obj, 'name', `trade.${fileBase}.set_name`,
                ctx, filepath, false)) replaced = true;
        } else if (func === 'set_lore') {
            if (processLore(obj, fileBase, ctx, filepath)) replaced = true;
        }

        for (const [key, value] of Object.entries(obj)) {
            if (key !== 'name' && key !== 'lore') scan(value);
        }
    }

    scan(json);
    return replaced;
}

// ================================================================
//  处理器：UI
// ================================================================

function processUI(json, filepath, ctx) {
    let replaced = false;
    const uiBase = filepath.split('/').pop().replace('.json', '');
    let counter = 0;

    function scan(obj) {
        if (Array.isArray(obj)) { for (const item of obj) scan(item); return; }
        if (!obj || typeof obj !== 'object') return;

        for (const [key, value] of Object.entries(obj)) {
            if (key === 'text' && typeof value === 'string') {
                if (value.startsWith('$') || value.startsWith('#')) continue;
                if (isAlreadyKey(value)) { ctx.referencedKeys.add(value); continue; }
                const baseKey = `ui.${uiBase}.text_${counter}`;
                counter++;
                if (replaceField(obj, 'text', baseKey, ctx, filepath, true)) replaced = true;
            } else scan(value);
        }
    }

    scan(json);
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
//  处理器：JS
// ================================================================

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildApiPattern(method) {
    const m = escapeRegex(method);
    return new RegExp(
        `(?:\\.${m}|\\["${m}"\\]|\\['${m}'\\])\\s*\\(\\s*(["'\`])((?:\\\\\\1|(?!\\1).)*)\\1`,
        'g'
    );
}

const JS_API_PATTERNS = [
    ['title', 'title'],
    ['body', 'body'],
    ['button', 'button'],
    ['button1', 'button'],
    ['button2', 'button'],
    ['label', 'label'],
    ['slider', 'slider'],
    ['dropdown', 'dropdown'],
    ['textField', 'textfield'],
    ['toggle', 'toggle'],
    ['sendMessage', 'sendmessage'],
    ['setTitle', 'settitle'],
    ['setSubtitle', 'setsubtitle'],
    ['setActionBar', 'setactionbar'],
    ['actionBar', 'actionbar'],
    ['runCommand', 'command'],
].map(([method, category]) => [buildApiPattern(method), category]);

function shouldSkipJsText(text) {
    const stripped = text.trim();
    if (!stripped) return true;
    if (/^\d+$/.test(stripped)) return true;
    if (isAlreadyKey(stripped)) return true;
    if (stripped.startsWith('./') || stripped.startsWith('/')) return true;
    if (/\.(js|json|png|ogg|wav)$/.test(stripped)) return true;

    // 含 @ → 技术标识符
    if (stripped.includes('@')) return true;

    // 纯小写字母数字下划线冒号 → 技术标识符（如 splint、minecraft）
    if (/^[a-z0-9_:]+$/.test(stripped)) return true;

    return false;
}

function translateCommandString(cmd, category, fileBase, ctx, filepath) {
    let replaced = false;
    const titleRe = new RegExp(
        `(title\\s+${SELECTOR}\\s+(?:actionbar|title|subtitle)\\s+)(.+?)(?=;|$)`,
        's'
    );

    const m = titleRe.exec(cmd);
    if (m) {
        const text = m[2].trim();
        if (!isAlreadyKey(text) && !text.startsWith('{')) {
            const key = makeUniqueKey(`script.${category}.${fileBase}`, ctx.usedKeys);
            const escaped = escapeLangValue(text);
            ctx.addKey(key, escaped, filepath);

            const before = cmd.substring(0, m.index);
            const after = cmd.substring(m.index + m[0].length);
            const prefix = m[1].replace('title ', 'titleraw ');
            const replacement = `${prefix}{"rawtext":[{"translate":"${key}"}]}`;
            cmd = `${before}${replacement}${after}`;
            replaced = true;
        }
    }

    cmd = cmd.replace(/("text"\s*:\s*")([^"]+)(")/g, (match, p1, text, p3) => {
        if (isAlreadyKey(text)) { ctx.referencedKeys.add(text); return match; }
        const key = makeUniqueKey(`script.${category}.${fileBase}`, ctx.usedKeys);
        const escaped = escapeLangValue(text);
        ctx.addKey(key, escaped, filepath);
        replaced = true;
        return `"translate":"${key}"`;
    });

    return [cmd, replaced];
}

function processJsFile(content, filepath, ctx) {
    const fileBase = filepath.split('/').pop()
        .replace(/\.(js|ts|mjs|cjs)$/i, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .toLowerCase();

    let replaced = false;

    for (const [pattern, category] of JS_API_PATTERNS) {
        const re = new RegExp(pattern.source, pattern.flags);
        let newContent = '';
        let lastIndex = 0;
        let m;

        re.lastIndex = 0;
        while ((m = re.exec(content)) !== null) {
            const matchStart = m.index;
            const matchEnd = m.index + m[0].length;
            const quote = m[1];
            const text = m[2];

            // 模板字符串插值
            if (quote === '`' && text.includes('${')) continue;
            if (shouldSkipJsText(text)) continue;

            // 拼接检查
            const tail = content.substring(matchEnd, matchEnd + 5).trimStart();
            if (tail.startsWith('+') || tail.startsWith('${')) continue;

            let replacement;
            if (category === 'command') {
                const [newCmd, changed] = translateCommandString(text, category, fileBase, ctx, filepath);
                if (!changed) continue;
                replaced = true;
                const escapedCmd = quote === '"' ? newCmd.replace(/"/g, '\\"') : newCmd;
                replacement = m[0].replace(quote + text + quote, `${quote}${escapedCmd}${quote}`);
            } else {
                const key = makeUniqueKey(`script.${category}.${fileBase}`, ctx.usedKeys);
                const escaped = escapeLangValue(text);
                ctx.addKey(key, escaped, filepath);
                replaced = true;
                replacement = m[0].replace(
                    quote + text + quote,
                    `{ rawtext: [{ translate: "${key}" }] }`
                );
            }

            newContent += content.substring(lastIndex, matchStart) + replacement;
            lastIndex = matchEnd;
        }
        newContent += content.substring(lastIndex);
        content = newContent;
    }

    return { content, changed: replaced };
}

// ================================================================
//  路径判断
// ================================================================

function matchDir(rel, ...dirs) {
    const parts = rel.replace(/\\/g, '/').split('/');
    for (const d of dirs) if (parts.includes(d)) return true;
    return false;
}

function shouldSkip(filename, rel) {
    if (filename.startsWith('._')) return true;
    if (['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(filename)) return true;
    const skipDirs = ['__MACOSX', 'node_modules', '.git', '.vscode'];
    const parts = rel.replace(/\\/g, '/').split('/');
    for (const p of parts) if (skipDirs.includes(p)) return true;
    return false;
}

// ================================================================
//  反混淆
// ================================================================

function stripJsonComments(content) {
    let result = '';
    let i = 0;
    const n = content.length;
    let inLineComment = false, inBlockComment = false, inString = false, stringChar = null;

    while (i < n) {
        const c = content[i];

        if (inLineComment) {
            if (c === '\n') { inLineComment = false; result += c; }
            i++; continue;
        }
        if (inBlockComment) {
            if (c === '*' && i + 1 < n && content[i + 1] === '/') {
                inBlockComment = false; i += 2; continue;
            }
            i++; continue;
        }
        if (inString) {
            if (c === '\\' && i + 1 < n) { result += c + content[i + 1]; i += 2; continue; }
            if (c === stringChar) { inString = false; stringChar = null; }
            result += c; i++; continue;
        }
        if (c === '/' && i + 1 < n) {
            if (content[i + 1] === '/') { inLineComment = true; i += 2; continue; }
            if (content[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
        }
        if (c === '"' || c === "'") { inString = true; stringChar = c; result += c; i++; continue; }

        result += c; i++;
    }
    return result;
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
//  lang 合并
// ================================================================

function mergeLang(existing, newEntries) {
    const merged = { ...existing };
    let added = 0, skipped = 0;
    for (const [key, value] of newEntries) {
        if (key in merged) skipped++;
        else { merged[key] = value; added++; }
    }
    return [merged, added, skipped];
}

function shouldCopy(key, value) {
    if (!value) return false;
    if (value === key) return false;
    if (value.startsWith('#')) return false;
    return true;
}

function fillFromEnUs(merged, enUs) {
    let filled = 0;
    for (const [key, value] of Object.entries(enUs)) {
        if (!(key in merged) && shouldCopy(key, value)) {
            merged[key] = value;
            filled++;
        }
    }
    return filled;
}

function langToString(entries) {
    return Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n');
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
        const zip = await JSZip.loadAsync(file);
        const allFiles = Object.keys(zip.files).filter(n => !zip.files[n].dir);
        log(`共 ${allFiles.length} 个文件`);

        const ctx = new ProcessContext();
        const updatedFiles = {};
        let processedCount = 0;
        let deobCount = 0;

        // 找包根
        const packRoots = [];
        for (const name of allFiles) {
            if (name.endsWith('manifest.json')) {
                const dir = name.substring(0, name.lastIndexOf('/'));
                packRoots.push(dir);
            }
        }
        log(`找到 ${packRoots.length} 个包`);

        // 遍历
        for (let i = 0; i < allFiles.length; i++) {
            const name = allFiles[i];
            const percent = 10 + Math.floor((i / allFiles.length) * 70);
            setProgress(percent, `处理: ${name.split('/').pop()}`);

            const filename = name.split('/').pop();
            const rel = name.substring(0, name.lastIndexOf('/')).toLowerCase();
            const lowerName = filename.toLowerCase();

            if (shouldSkip(filename, rel)) continue;

            // ---- JS 文件 ----
            if (lowerName.endsWith('.js') || lowerName.endsWith('.ts') ||
                lowerName.endsWith('.mjs') || lowerName.endsWith('.cjs')) {
                let content;
                try {
                    content = await zip.files[name].async('string');
                } catch (e) {
                    log(`[跳过] ${name}: 读取失败`, 'warn');
                    continue;
                }

                const { content: newContent, changed } = processJsFile(content, name, ctx);
                if (changed) {
                    updatedFiles[name] = newContent;
                    processedCount++;
                    log(`[脚本] ${name}`, 'info');
                }
                continue;
            }

            // ---- JSON 文件 ----
            if (!lowerName.endsWith('.json')) continue;

            let content;
            try {
                content = await zip.files[name].async('string');
            } catch (e) {
                log(`[跳过] ${name}: 读取失败`, 'warn');
                continue;
            }

            const { data, changed } = deobfuscateJson(content);
            if (changed) {
                deobCount++;
                log(`[反混淆] ${name}`, 'info');
            }
            if (!data) {
                log(`[跳过] ${name}: 解析失败`, 'warn');
                continue;
            }

            let replaced = false;

            if (lowerName === 'manifest.json') {
                replaced = processManifest(data, name, ctx);
            } else if (matchDir(rel, 'trading', 'trades', 'trade_tables')) {
                replaced = processTrading(data, name, ctx);
            } else if (matchDir(rel, 'items', 'item', 'item_definitions')) {
                replaced = processItem(data, name, ctx);
            } else if (matchDir(rel, 'blocks', 'block', 'block_definitions')) {
                replaced = processBlock(data, name, ctx);
            } else if (matchDir(rel, 'entities', 'entity')) {
                replaced = processEntity(data, name, ctx);
            } else if (matchDir(rel, 'dialogue', 'dialogues')) {
                replaced = processDialogue(data, name, ctx);
            } else if (matchDir(rel, 'ui')) {
                replaced = processUI(data, name, ctx);
            }

            if (replaced || changed) {
                updatedFiles[name] = JSON.stringify(data, null, 2);
                if (replaced) processedCount++;
            }
        }

        log(`反混淆: ${deobCount} 个文件`);
        log(`处理: ${processedCount} 个文件`);
        log(`生成键: ${ctx.langEntries.length} 条`);

        // 写回
        setProgress(80, '写入文件...');
        for (const [path, content] of Object.entries(updatedFiles)) {
            zip.file(path, content);
        }

        // 生成 lang
        setProgress(85, '生成 lang...');
        if (ctx.langEntries.length > 0) {
            for (const root of packRoots) {
                const textsDir = root ? `${root}/texts` : 'texts';
                const zhPath = `${textsDir}/zh_CN.lang`;
                const enPath = `${textsDir}/en_US.lang`;

                let existingZh = {};
                const zhFile = zip.file(zhPath);
                if (zhFile) {
                    try { existingZh = parseLang(await zhFile.async('string')); } catch (e) { }
                }

                let existingEn = {};
                const enFile = zip.file(enPath);
                if (enFile) {
                    try { existingEn = parseLang(await enFile.async('string')); } catch (e) { }
                }

                const packEntries = ctx.langEntries.filter(([k]) => k.startsWith('pack.'));
                const otherEntries = ctx.langEntries.filter(([k]) => !k.startsWith('pack.'));

                const [merged, added, skipped] = mergeLang(existingZh, [...otherEntries, ...packEntries]);
                const enFilled = fillFromEnUs(merged, existingEn);

                zip.file(zhPath, langToString(merged));
                log(`[lang] ${zhPath}: 新增 ${added}，跳过 ${skipped}，从 en_US 补 ${enFilled}`, 'info');

                // languages.json
                const langJsonPath = `${textsDir}/languages.json`;
                let langs = ['en_US'];
                const langFile = zip.file(langJsonPath);
                if (langFile) {
                    try {
                        langs = JSON.parse(await langFile.async('string'));
                        if (!Array.isArray(langs)) langs = ['en_US'];
                    } catch (e) { }
                }
                if (!langs.includes('zh_CN')) {
                    langs.push('zh_CN');
                    zip.file(langJsonPath, JSON.stringify(langs, null, 2));
                }
            }
        }

        // 打包
        setProgress(90, '打包中...');
        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });

        state.resultBlob = blob;
        state.resultName = `${state.originalName}_zh_modified.mcaddon`;

        setProgress(100, '完成！');
        log(`✅ 处理完成: ${state.resultName}`, 'info');

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