/*
 * 最低可用游戏版本估算
 *
 * 附加包：取下面几项里最高的一个
 *   - manifest 的 min_engine_version（作者自己填的，常常偏低，只作参考）
 *   - 脚本 API：@minecraft/server 模块版本 → 首次正式提供它的游戏版本（官方对照表）
 *     使用 -beta 版本时，只能在对应的那一个游戏版本里开启“测试版 API”运行
 *   - items / blocks / entities 等文件的 format_version：游戏不加载 format_version 比自身新的文件
 * 存档：level.dat 的 MinimumCompatibleClientVersion（游戏自己写的，最准确）
 */
(function (NS) {
    'use strict';

    // @minecraft/server 稳定版 → 游戏版本
    // 1.0.0 ~ 1.17.0 来自官方文档 Script Versioning；之后按每个正式版 +1 推算，
    // 已用文档里的 rc / beta 标签核对（如 2.2.0-beta.1.21.100-preview、2.12.0-beta.1.26.60-preview）
    const SERVER_STABLE = [
        ['1.0.0', '1.19.70'], ['1.1.0', '1.19.80'], ['1.2.0', '1.20.0'], ['1.3.0', '1.20.10'], ['1.4.0', '1.20.20'],
        ['1.5.0', '1.20.30'], ['1.6.0', '1.20.40'], ['1.7.0', '1.20.50'], ['1.8.0', '1.20.60'], ['1.9.0', '1.20.70'],
        ['1.10.0', '1.20.80'], ['1.11.0', '1.21.0'], ['1.12.0', '1.21.10'], ['1.13.0', '1.21.20'], ['1.14.0', '1.21.30'],
        ['1.15.0', '1.21.40'], ['1.16.0', '1.21.50'], ['1.17.0', '1.21.60'], ['1.18.0', '1.21.70'], ['1.19.0', '1.21.80'],
        ['2.0.0', '1.21.90'], ['2.1.0', '1.21.100'], ['2.2.0', '1.21.110'], ['2.3.0', '1.21.120'], ['2.4.0', '1.21.130'],
        ['2.5.0', '1.26.0'], ['2.6.0', '1.26.10'], ['2.7.0', '1.26.20'], ['2.8.0', '1.26.30'], ['2.9.0', '1.26.40'],
        ['2.10.0', '1.26.50'], ['2.11.0', '1.26.60'], ['2.12.0', '1.26.70'],
    ].map(([m, g]) => [parse(m), parse(g)]);

    function parse(v) {
        if (Array.isArray(v)) return v.map(n => Number(n) || 0).slice(0, 3).concat([0, 0, 0]).slice(0, 3);
        const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || '').trim());
        return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
    }
    function cmp(a, b) {
        // 26.10 这种新编号统一成 1.26.10 再比较
        const n = (v) => (v[0] >= 26 && v[0] < 100) ? [1, v[0], v[1]] : v;
        a = n(a); b = n(b);
        for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
    }
    /** 显示：1.26.10 → 26.10；1.21.90 → 1.21.90 */
    function label(v) {
        if (!v) return '';
        if (v[0] === 1 && v[1] >= 26) return `${v[1]}.${v[2]}`;
        return v.join('.');
    }

    /** 脚本模块依赖 → { game, beta, newer } */
    function serverModuleGame(version) {
        const s = String(version || '').trim();
        const mv = parse(s);
        if (!mv) return null;
        const beta = /-beta/i.test(s);
        const idx = SERVER_STABLE.findIndex(([m]) => cmp(m, mv) === 0);
        if (!beta) {
            if (idx >= 0) return { game: SERVER_STABLE[idx][1] };
            // 不在表里：比表里最新的还新 → 至少是最新已知版本之后；更旧的小版本取不超过它的最高一项
            const last = SERVER_STABLE[SERVER_STABLE.length - 1];
            if (cmp(mv, last[0]) > 0) return { game: last[1], newer: true };
            let best = null;
            for (const [m, g] of SERVER_STABLE) if (cmp(m, mv) <= 0) best = g;
            return best ? { game: best } : null;
        }
        // X.Y.0-beta 出现在 X.(Y-1).0 正式发布的那个游戏版本里（2.0.0-beta → 1.19.0 → 1.21.80）
        let prev = null;
        for (const [m, g] of SERVER_STABLE) if (cmp(m, mv) < 0) prev = g;
        if (!prev) return null;
        const last = SERVER_STABLE[SERVER_STABLE.length - 1];
        // 比“最新稳定版 +1”还新的测试版：表里还没有对应的游戏版本
        const next = [last[0][0], last[0][1] + 1, 0];
        return { game: prev, beta: true, newer: cmp(mv, next) > 0 };
    }

    /**
     * @param {{manifests: {path:string, manifest:object}[], formats: {file:string, version:string}[]}} input
     * @returns {{version:number[], label:string, basis:object[], beta:object|null}|null}
     */
    function estimateAddon({ manifests, formats }) {
        const basis = [];
        let best = null, beta = null;
        const bump = (v, b) => { basis.push(b); if (v && (!best || cmp(v, best) > 0)) best = v; };
        // min_engine_version：取最高的一个
        let eng = null, engFile = '';
        for (const { path, manifest } of manifests) {
            const v = manifest && manifest.header && parse(manifest.header.min_engine_version);
            if (v && (!eng || cmp(v, eng) > 0)) { eng = v; engFile = path; }
        }
        if (eng) bump(eng, { k: 'engine', v: label(eng), file: engFile });
        // 脚本 API
        let scr = null, scrMod = '', scrNewer = false;
        for (const { path, manifest } of manifests) {
            for (const d of (manifest && manifest.dependencies) || []) {
                if (!d || d.module_name !== '@minecraft/server') continue;
                const r = serverModuleGame(d.version);
                if (!r) continue;
                if (r.beta && !r.newer) { if (!beta || cmp(r.game, beta.game) > 0) beta = { game: r.game, mod: `@minecraft/server ${d.version}`, file: path }; continue; }
                if (!scr || cmp(r.game, scr) > 0) { scr = r.game; scrMod = `@minecraft/server ${d.version}`; scrNewer = !!r.newer; }
            }
        }
        if (scr) bump(scr, { k: scrNewer ? 'newer' : 'script', v: label(scr), mod: scrMod });
        if (beta) bump(beta.game, { k: 'beta', v: label(beta.game), mod: beta.mod });
        // format_version
        let fmt = null, fmtFile = '';
        for (const { file, version } of formats) {
            const v = parse(version);
            if (v && (!fmt || cmp(v, fmt) > 0)) { fmt = v; fmtFile = file; }
        }
        if (fmt) bump(fmt, { k: 'format', v: label(fmt), file: fmtFile });
        if (!best) return null;
        return { version: best, label: label(best), basis, beta: beta ? { label: label(beta.game), mod: beta.mod } : null };
    }

    /** level.dat 根复合标签 → { version, label, lastOpened } */
    function estimateWorld(levelCompound) {
        const NBT = NS.NBT;
        const listOf = (name) => {
            const c = NBT.child(levelCompound, name);
            if (!c || !c.v || !Array.isArray(c.v.items)) return null;
            const nums = c.v.items.map(Number).filter(n => Number.isFinite(n));
            return nums.length >= 3 ? nums.slice(0, 3) : null;
        };
        const min = listOf('MinimumCompatibleClientVersion');
        const last = listOf('lastOpenedWithVersion');
        if (!min && !last) return null;
        const v = min || last;
        return { version: v, label: label(v), basis: [{ k: min ? 'world' : 'worldLast', v: label(v) }], lastOpened: last ? label(last) : '' };
    }

    /** 合并：存档自带包的要求高于存档本身时补一条依据 */
    function mergeWorld(world, packs) {
        if (!world) return packs;
        if (!packs) return world;
        const out = { ...world, basis: [...world.basis], beta: packs.beta };
        out.basis.push({ k: 'packs', v: packs.label });
        if (cmp(packs.version, world.version) > 0) { out.version = packs.version; out.label = packs.label; }
        return out;
    }

    /** 日志用的说明行 */
    function describe(mv, packVersions) {
        const lines = [];
        for (const p of packVersions || []) lines.push(`[版本] ${p.type === 'BP' ? '行为包' : p.type === 'RP' ? '资源包' : '包'} ${p.name || p.root || '(根目录)'}：manifest 版本号 ${p.version || '未填写'}`);
        if (mv) {
            const why = mv.basis.map(b => b.k === 'engine' ? `min_engine_version ${b.v}` : b.k === 'format' ? `format_version 最高 ${b.v}（${b.file}）`
                : b.k === 'world' ? `level.dat MinimumCompatibleClientVersion ${b.v}` : b.k === 'worldLast' ? `level.dat lastOpenedWithVersion ${b.v}`
                : b.k === 'packs' ? `存档自带包 ${b.v}` : b.k === 'beta' ? `测试版 API ${b.mod} → 仅 ${b.v}` : `${b.mod} → ${b.v}${b.k === 'newer' ? ' 以上' : ''}`).join('；');
            lines.push(`[版本] 最低可用版本：${mv.label}（${why}${mv.lastOpened ? `；上次用 ${mv.lastOpened} 打开` : ''}）`);
            if (mv.beta) lines.push(`[版本] ⚠ 使用了测试版脚本 API ${mv.beta.mod}：只能在 ${mv.beta.label} 开启“测试版 API”实验性玩法后运行`);
        }
        return lines;
    }

    NS.MinVersion = { describe, parse, cmp, label, serverModuleGame, estimateAddon, estimateWorld, mergeWorld, SERVER_STABLE };
})(globalThis.AddonI18n = globalThis.AddonI18n || {});
