import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RULE_CONFIG, DEFAULT_SEVERITIES } from './rules.js';
import { DEFAULT_JUDGE_MODEL, JUDGE_EFFORTS } from './judge.js';
export const CONFIG_FILENAME = 'gatekeep.config.json';
/** The Stop hook is installed with this ceiling (`src/install.ts`); the test budget has to fit inside it with room to spare. */
export const STOP_HOOK_TIMEOUT_MS = 600_000;
const MAX_TEST_BUDGET_MS = 540_000;
export function defaultConfig() {
    return { rules: { ...DEFAULT_RULE_CONFIG, severities: { ...DEFAULT_RULE_CONFIG.severities } }, maxBlocks: 3, strict: false, testCommand: null, testTimeoutMs: 300000, judge: null };
}
/**
 * Parse config text. Never throws and never disables the gate: a broken file yields the defaults plus a list of problems
 * the caller surfaces as findings. Unknown rule names are reported rather than silently ignored.
 */
export function parseConfig(raw) {
    const cfg = defaultConfig();
    const problems = [];
    if (raw === null || raw === undefined || raw.trim() === '')
        return { cfg, problems };
    let j;
    try {
        j = JSON.parse(raw);
    }
    catch (e) {
        problems.push(`invalid JSON (${e.message}); using defaults`);
        return { cfg, problems };
    }
    if (typeof j !== 'object' || j === null || Array.isArray(j)) {
        problems.push('top level must be an object; using defaults');
        return { cfg, problems };
    }
    const strs = (k) => Array.isArray(j[k]) && j[k].every((x) => typeof x === 'string') ? j[k] : (j[k] !== undefined ? (problems.push(`"${k}" must be an array of strings`), null) : null);
    const tg = strs('testGlobs');
    if (tg)
        cfg.rules.testGlobs = tg;
    const etg = strs('extraTestGlobs');
    if (etg)
        cfg.rules.testGlobs = [...cfg.rules.testGlobs, ...etg];
    const tcg = strs('testConfigGlobs');
    if (tcg)
        cfg.rules.testConfigGlobs = tcg;
    const ig = strs('ignore');
    if (ig)
        cfg.rules.ignoreGlobs = [...cfg.rules.ignoreGlobs, ...ig];
    const pp = strs('protectedPaths');
    if (pp)
        cfg.rules.protectedGlobs = pp;
    const epp = strs('extraProtectedPaths');
    if (epp)
        cfg.rules.protectedGlobs = [...cfg.rules.protectedGlobs, ...epp];
    if (j.assertionDropTolerance !== undefined) {
        if (typeof j.assertionDropTolerance === 'number')
            cfg.rules.assertionDropTolerance = j.assertionDropTolerance;
        else
            problems.push('"assertionDropTolerance" must be a number');
    }
    if (j.maxBlocks !== undefined) {
        if (typeof j.maxBlocks === 'number' && j.maxBlocks >= 0)
            cfg.maxBlocks = j.maxBlocks;
        else
            problems.push('"maxBlocks" must be a non-negative number');
    }
    if (j.strict !== undefined) {
        if (typeof j.strict === 'boolean')
            cfg.strict = j.strict;
        else
            problems.push('"strict" must be a boolean');
    }
    if (j.testCommand !== undefined) {
        if (j.testCommand === null || (typeof j.testCommand === 'string' && j.testCommand.trim() !== ''))
            cfg.testCommand = j.testCommand === null ? null : j.testCommand.trim();
        else
            problems.push('"testCommand" must be a non-empty string or null');
    }
    if (j.testTimeoutMs !== undefined) {
        if (typeof j.testTimeoutMs === 'number' && j.testTimeoutMs > 0) {
            cfg.testTimeoutMs = j.testTimeoutMs;
            if (j.testTimeoutMs > MAX_TEST_BUDGET_MS)
                problems.push(`"testTimeoutMs" of ${j.testTimeoutMs} ms leaves the Stop hook no room inside its ${STOP_HOOK_TIMEOUT_MS} ms limit; a hook the harness kills returns no decision and the gate passes silently`);
        }
        else
            problems.push('"testTimeoutMs" must be a positive number');
    }
    if (j.judge !== undefined && j.judge !== null && j.judge !== false) {
        if (j.judge && typeof j.judge === 'object' && !Array.isArray(j.judge)) {
            const jj = j.judge;
            const jc = { model: DEFAULT_JUDGE_MODEL, provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxDiffBytes: 200 * 1024, canBlock: false, effort: 'high' };
            if (jj.model !== undefined) {
                if (typeof jj.model === 'string' && jj.model.trim() !== '')
                    jc.model = jj.model.trim();
                else
                    problems.push('"judge.model" must be a non-empty string');
            }
            if (jj.apiKeyEnv !== undefined) {
                if (typeof jj.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(jj.apiKeyEnv))
                    jc.apiKeyEnv = jj.apiKeyEnv;
                else
                    problems.push('"judge.apiKeyEnv" must be an environment variable name');
            }
            if (jj.provider !== undefined) {
                if (typeof jj.provider === 'string' && jj.provider.trim() !== '')
                    jc.provider = jj.provider.trim();
                else
                    problems.push('"judge.provider" must be a non-empty string');
            }
            if (jj.maxDiffBytes !== undefined) {
                if (typeof jj.maxDiffBytes === 'number' && jj.maxDiffBytes >= 1024)
                    jc.maxDiffBytes = Math.floor(jj.maxDiffBytes);
                else
                    problems.push('"judge.maxDiffBytes" must be a number of at least 1024');
            }
            if (jj.canBlock !== undefined) {
                if (typeof jj.canBlock === 'boolean')
                    jc.canBlock = jj.canBlock;
                else
                    problems.push('"judge.canBlock" must be a boolean');
            }
            if (jj.effort !== undefined) {
                if (typeof jj.effort === 'string' && JUDGE_EFFORTS.includes(jj.effort))
                    jc.effort = jj.effort;
                else
                    problems.push(`"judge.effort" must be one of ${JUDGE_EFFORTS.join(', ')}`);
            }
            for (const k of Object.keys(jj))
                if (!['model', 'provider', 'apiKeyEnv', 'maxDiffBytes', 'canBlock', 'effort'].includes(k))
                    problems.push(`unknown key "judge.${k}"`);
            cfg.judge = jc;
        }
        else
            problems.push('"judge" must be an object (or null to disable)');
    }
    if (j.rules !== undefined) {
        if (j.rules && typeof j.rules === 'object' && !Array.isArray(j.rules)) {
            for (const [k, v] of Object.entries(j.rules)) {
                if (!(k in DEFAULT_SEVERITIES)) {
                    problems.push(`unknown rule "${k}"`);
                    continue;
                }
                if (v === 'block' || v === 'warn' || v === 'off')
                    cfg.rules.severities[k] = v;
                else
                    problems.push(`rule "${k}" must be "block", "warn" or "off"`);
            }
        }
        else
            problems.push('"rules" must be an object');
    }
    const known = new Set(['$schema', 'testGlobs', 'extraTestGlobs', 'testConfigGlobs', 'ignore', 'assertionDropTolerance', 'maxBlocks', 'strict', 'rules', 'testCommand', 'testTimeoutMs', 'protectedPaths', 'extraProtectedPaths', 'judge']);
    // JSON has no comments; a key starting with "//" is one. The generated config uses them to record what install detected.
    for (const k of Object.keys(j))
        if (!known.has(k) && !k.startsWith('//'))
            problems.push(`unknown key "${k}"`);
    return { cfg, problems };
}
export async function readConfigText(root) {
    try {
        return await fs.readFile(path.join(root, CONFIG_FILENAME), 'utf8');
    }
    catch {
        return null;
    }
}
/**
 * `testCommand` is filled in from whatever `gatekeep install` detected, with the detection recorded in a `//`
 * comment key so the reader can see where it came from and delete it without guessing. Null stays null: a
 * repository whose suite we could not identify keeps the original-tests lane off rather than getting a wrong command.
 */
export function defaultConfigText(detected) {
    const cfg = {
        maxBlocks: 3,
        strict: false,
    };
    if (detected)
        cfg['// testCommand'] = `detected from ${detected.from}; the original tests are restored and run against the final code. Set to null to turn this off.`;
    else
        cfg['// testCommand'] = 'no test command detected. Set it to run the session\'s original tests against the final code.';
    cfg.testCommand = detected ? detected.command : null;
    Object.assign(cfg, {
        judge: null,
        extraTestGlobs: [],
        extraProtectedPaths: [],
        ignore: [],
        rules: { ...DEFAULT_RULE_CONFIG.severities },
    });
    return JSON.stringify(cfg, null, 2) + '\n';
}
//# sourceMappingURL=config.js.map