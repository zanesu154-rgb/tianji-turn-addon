/* ================================================================
 *  commands.js —— 命令文本处理
 *   title  <目标> title|subtitle|actionbar <文本>  →  titleraw ... {"rawtext":[{"translate":...}]}
 *   tellraw / titleraw 的 JSON                     →  text 节点改为 translate（保留 with/score/selector）
 *   say / tell / msg / w      →  按选项转为 tellraw / titleraw（默认 tellraw）
 *   me / scoreboard 显示名    →  无法本地化，只记录到报告
 * ================================================================ */
(function (root) {
    'use strict';
    const NS = root.AddonI18n;

    /** 从 i 开始读取一个命令目标（选择器 / 引号名字 / 普通名字），返回结束位置 */
    function readTarget(s, i) {
        if (s[i] === '@') {
            i++;
            while (i < s.length && /[A-Za-z_]/.test(s[i])) i++;
            let j = i;
            while (j < s.length && /\s/.test(s[j])) j++;
            if (s[j] === '[') {
                i = j;
                let depth = 0, inStr = false;
                for (; i < s.length; i++) {
                    const c = s[i];
                    if (inStr) {
                        if (c === '\\') { i++; continue; }
                        if (c === '"') inStr = false;
                        continue;
                    }
                    if (c === '"') inStr = true;
                    else if (c === '[' || c === '{') depth++;
                    else if (c === ']' || c === '}') {
                        depth--;
                        if (depth === 0) { i++; break; }
                    }
                }
            }
            return i;
        }
        if (s[i] === '"') {
            i++;
            while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
            return i + 1;
        }
        while (i < s.length && !/\s/.test(s[i])) i++;
        return i;
    }

    function skipWs(s, i) {
        while (i < s.length && /\s/.test(s[i])) i++;
        return i;
    }

    function readWord(s, i) {
        const st = i;
        while (i < s.length && !/\s/.test(s[i])) i++;
        return [s.substring(st, i), i];
    }

    /** 找到真正执行的那条命令的起点（跳过开头的 / 和 execute ... run） */
    function findCommandStart(cmd) {
        let i = skipWs(cmd, 0);
        if (cmd[i] === '/') i++;
        for (let guard = 0; guard < 20; guard++) {
            const [w] = readWord(cmd, i);
            if (w.toLowerCase() !== 'execute') return i;
            // 在 execute 里找 run（跳过选择器方括号和引号）
            let depth = 0, inStr = false, found = -1;
            for (let j = i + 7; j < cmd.length; j++) {
                const c = cmd[j];
                if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
                if (c === '"') { inStr = true; continue; }
                if (c === '[' || c === '{') depth++;
                else if (c === ']' || c === '}') depth--;
                else if (depth === 0 && /\s/.test(cmd[j - 1] || ' ') && cmd.startsWith('run', j) && /\s/.test(cmd[j + 3] || '')) {
                    found = j + 3;
                    break;
                }
            }
            if (found < 0) return -1;
            i = skipWs(cmd, found);
            if (cmd[i] === '/') i++;
        }
        return -1;
    }

    function markForJson(text) {
        // 从纯文本搬进 JSON 字符串的占位符需要 JSON 转义
        return text.replace(/(\d+)/g, '$1');
    }


    /**
     * say 文本 → tellraw / titleraw。
     *  - 消息里的选择器（@p、@a[…]）保留为 selector，作为翻译参数 %1$s …
     *  - tellraw 保留 say 的“[发送者] ”前缀；发送者默认为执行者 @s，命令方块传入它的名字
     */
    function convertSay(text, target, mode, ctx, baseKey, meta, sender) {
        const sels = [];
        const value = text.replace(/%/g, '%%').replace(/@[aeprsvn](?:\[[^\]]*\])?|@initiator/g, (m) => { sels.push({ selector: m }); return `%${sels.length}$s`; });
        const literal = value.replace(/%\d+\$s/g, ' ');
        if (!NS.looksLikeText(literal)) return null;
        const finalValue = sels.length ? value : text;
        const key = ctx.alloc(baseKey, finalValue, meta);
        const node = sels.length ? { translate: key, with: { rawtext: sels } } : { translate: key };
        const who = sender || { selector: '@s' };
        if (mode === 'tellraw') {
            return `tellraw ${target} ${JSON.stringify({ rawtext: [{ text: '[' }, who, { text: '] ' }, node] })}`;
        }
        const sub = mode === 'actionbar' ? 'actionbar' : 'title';
        return `titleraw ${target} ${sub} ${JSON.stringify({ rawtext: [node] })}`;
    }

    /**
     * 处理一条命令。
     * @returns {{cmd: string, changed: boolean}}
     */
    function translateCommand(cmd, ctx, baseKey, file, opts = {}) {
        if (typeof cmd !== 'string' || !cmd.trim()) return { cmd, changed: false };
        const start = findCommandStart(cmd);
        if (start < 0) return { cmd, changed: false };

        const prefix = cmd.substring(0, start);
        const [kwRaw, afterKw] = readWord(cmd, start);
        const kw = kwRaw.toLowerCase();
        const meta = { file, kind: 'command', scope: 'command' };

        if (kw === 'title') {
            const tStart = skipWs(cmd, afterKw);
            const tEnd = readTarget(cmd, tStart);
            const sStart = skipWs(cmd, tEnd);
            const [sub, sEnd] = readWord(cmd, sStart);
            if (!['title', 'subtitle', 'actionbar'].includes(sub.toLowerCase())) return { cmd, changed: false };
            const textStart = skipWs(cmd, sEnd);
            const text = cmd.substring(textStart).replace(/\s+$/, '');
            if (!text || text.startsWith('{')) return { cmd, changed: false };
            const parts = ctx.rawParts(markForJson(text), baseKey, meta);
            if (!parts) return { cmd, changed: false };
            const out = `${prefix}titleraw ${cmd.substring(tStart, tEnd)} ${sub} ${JSON.stringify({ rawtext: parts })}`;
            return { cmd: out, changed: true };
        }

        if (kw === 'tellraw' || kw === 'titleraw') {
            const tStart = skipWs(cmd, afterKw);
            const tEnd = readTarget(cmd, tStart);
            let jsonStart = skipWs(cmd, tEnd);
            let head = cmd.substring(0, jsonStart);
            if (kw === 'titleraw') {
                const [sub, sEnd] = readWord(cmd, jsonStart);
                if (!['title', 'subtitle', 'actionbar'].includes(sub.toLowerCase())) return { cmd, changed: false };
                jsonStart = skipWs(cmd, sEnd);
                head = cmd.substring(0, jsonStart);
            }
            const jsonText = cmd.substring(jsonStart).trim();
            let data;
            try { data = JSON.parse(jsonText); } catch (e) { data = undefined; }
            if (data && typeof data === 'object') {
                if (!ctx.processRawMessage(data, baseKey, meta)) return { cmd, changed: false };
                return { cmd: head + JSON.stringify(data), changed: true };
            }
            // JSON 不合法（比如模板字符串把结构拆开了）→ 只替换完整的 "text":"..." 字面量
            let changed = false;
            const replaced = jsonText.replace(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (all, raw) => {
                let value;
                try { value = JSON.parse(`"${raw}"`); } catch (e) { return all; }
                if (/[-]/.test(value)) return all;
                const parts = ctx.rawParts(value, baseKey, meta);
                if (!parts || parts.length !== 1 || !parts[0].translate) return all;
                changed = true;
                return `"translate":${JSON.stringify(parts[0].translate)}`;
            });
            return changed ? { cmd: head + replaced, changed: true } : { cmd, changed: false };
        }

        // ---- say / tell / msg / w：按选项转换成 tellraw / titleraw，否则只记录 ----
        if (kw === 'say' || kw === 'me' || kw === 'tell' || kw === 'msg' || kw === 'w') {
            const isTell = kw !== 'say' && kw !== 'me';
            const tStart = skipWs(cmd, afterKw);
            const tEnd = isTell ? readTarget(cmd, tStart) : tStart;
            const target = isTell ? cmd.substring(tStart, tEnd) : '@a';
            const text = cmd.substring(skipWs(cmd, tEnd)).replace(/\s+$/, '');
            const mode = ctx.sayMode || 'keep';
            const conv = kw !== 'me' && mode !== 'keep' ? convertSay(text, target, mode, ctx, baseKey, meta, opts.sender) : null;
            if (conv) return { cmd: prefix + conv, changed: true };
            if (NS.looksLikeText(text)) ctx.report(file, `/${kw}`, text, `${kw} 命令不支持翻译键（可在选项中设置转换为 tellraw / titleraw）`);
            return { cmd, changed: false };
        }
        if (kw === 'scoreboard') {
            const m = /^scoreboard\s+objectives\s+add\s+\S+\s+\S+\s+(.+)$/i.exec(cmd.substring(start));
            if (m && NS.looksLikeText(m[1])) ctx.report(file, '/scoreboard objectives add', m[1].replace(/^"|"$/g, ''), '计分板显示名不支持翻译键');
        }
        return { cmd, changed: false };
    }

    /** 粗略判断一个字符串是不是命令（用于动画、脚本里的字符串） */
    // 区分大小写：玩家文本一般首字母大写或是中文，不会误判
    const STRONG_COMMANDS = /^\/?(execute|title|titleraw|tellraw|say|scoreboard|effect|tp|teleport|summon|playsound|particle|setblock|structure|gamemode|gamerule|replaceitem|enchant|xp|stopsound|playanimation|scriptevent|tickingarea|inputpermission|spawnpoint|dialogue|camerashake|testfor|clone|weather|difficulty)\s+\S/;
    // 这些词也是常见英文单词，必须带 / 或后面跟选择器才算命令
    const WEAK_COMMANDS = /^(?:\/(say|tell|msg|w|me|tag|give|clear|kill|fill|function|event|camera|damage|ride|loot|music|fog|hud|time|list|op|kick|schedule|place)\s|(tell|msg|w|tag|give|clear|kill|event|camera|damage|ride|loot)\s+[@"])/;

    // 所有命令名（小写）。后面跟着坐标 / 数字 / 选择器 / 命名空间 ID 时一定是命令
    const ALL_COMMANDS = /^\/?(execute|title|titleraw|tellraw|say|tell|msg|w|me|scoreboard|tag|give|clear|effect|tp|teleport|summon|kill|function|playsound|particle|setblock|fill|clone|structure|gamemode|gamerule|event|dialogue|camera|camerashake|replaceitem|enchant|xp|weather|time|difficulty|spawnpoint|setworldspawn|inputpermission|ability|music|stopsound|playanimation|damage|ride|loot|schedule|scriptevent|tickingarea|fog|hud|testfor|testforblock|testforblocks|place|spreadplayers|recipe|alwaysday|mobevent|volumearea|transfer|locate|op|deop|kick|list)\s+(.*)$/s;
    const AMBIGUOUS = /^(say|tell|w|me|tag|give|clear|kill|fill|event|camera|music|damage|ride|loot|time|list|place|op|kick|schedule|function|enchant|weather|difficulty|recipe|transfer|locate|hud|fog|ability|clone|structure|effect)$/;
    const ARG_TOKEN = /(^|\s)(~|\^|-?\d|@[aeprsvn]\b|[a-z0-9_]+:[a-z0-9_]|"[^"]*"\s|true\b|false\b)/;

    function looksLikeCommand(s) {
        if (typeof s !== 'string') return false;
        const t = s.trim();
        if (STRONG_COMMANDS.test(t) || WEAK_COMMANDS.test(t)) return true;
        const m = ALL_COMMANDS.exec(t);
        if (!m) return false;
        // 同时是英文单词的命令名：要求第一个参数就像命令参数（避免 "list of items: 3 swords"）
        if (AMBIGUOUS.test(m[1])) return ARG_TOKEN.test(m[2].split(/\s+/)[0] + ' ');
        return ARG_TOKEN.test(m[2]);
    }

    NS.translateCommand = translateCommand;
    NS.looksLikeCommand = looksLikeCommand;
    NS.findCommandStart = findCommandStart;
})(typeof globalThis !== 'undefined' ? globalThis : this);
