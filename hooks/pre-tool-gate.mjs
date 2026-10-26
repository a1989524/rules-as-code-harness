#!/usr/bin/env node
// PreToolUse hook shared by Claude Code and Codex. Runs before every tool call and can stop it:
//   - deny: shell reads of secret files, secrets in outbound requests, any call to the banned tool
//     (hooks.bannedTool; the author bans a search API that bills per call) — every time;
//   - ask: dangerous commands such as git reset --hard or npm publish (Claude; Codex has no "ask",
//     its own approval policy covers these, so the hook only logs there);
//   - deny once per rule per user prompt: a scene rule (not in hooks.mustRules) the call needs but the
//     session has not read yet, a plan or new project written before any reuse search, and a skill's
//     script run (or scripted) before that skill was loaded;
//   - ask once per directory per user prompt: Read, Grep or Glob outside the read whitelist (core.md
//     "Permissions and writes", hooks.readAllow). Subagents are checked too. Shell reads outside it are only logged.
// Each check has a switch in adapters.json hooks.enforce (off / warn / enforce). "warn" only logs.
// Security checks fail closed on their own errors; everything else fails open.
// Usage: node pre-tool-gate.mjs --host claude|codex   (JSON on stdin)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readStdinJson, hooksDisabled, loadHookConfig, appendLog, stateDir,
  coverageContext, classifyCall, readToolCalls, readsRule, isRuleRead, touchesSensitive,
  enforceLevel, isMustRule, toplevel, SENSITIVE_READ_VERB, classifyPrompt,
  realPath, readWhitelist, readPlace, namedInPrompt, shellReadPaths, PROJECT_TEMP, ROOT,
} from './lib.mjs';

const host = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'unknown';

// Key-name extraction is the approved way to look at .env (rules/trust-and-secrets.md), so it passes.
const KEY_ONLY = /grep\s+-[a-zA-Z]*o[a-zA-Z]*\s+['"]\^\[A-Za-z_\]|cut\s+-d\s*['"]?=['"]?\s+-f\s*1\b|-split\s*['"]=['"]\s*,\s*2\)\[0\]/;
const SECRET_QUERY = /[?&](token|access_token|api_?key|key|secret|password|auth)=/i;
const GIT_RULE = /\bgit\s+(reset|checkout|restore|clean|stash|commit|push|rebase|merge|cherry-pick|worktree|branch\s+-[dD])\b/;
const TEST_RULE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|\b(pytest|vitest|jest|playwright\s+test|go\s+test|cargo\s+test)\b/;

// Returns { check, decision: 'deny'|'ask', reason, once? } or null.
// safetyOnly: run sections 1-2 (banned tool, sensitive reads, secret egress, dangerous commands) and stop; used for
// subagents, whose process gates (scene rules, reuse, skill scripts, analysis) stay with the parent.
export function decide(input, { cfg, dir, host: h, safetyOnly = false }) {
  const name = typeof input.tool_name === 'string' ? input.tool_name : '';
  const ti = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const rc = cfg.ruleCoverage || {};
  const shell = (rc.shellTools || ['Bash', 'PowerShell', 'shell', 'local_shell', 'exec_command']).includes(name) || typeof ti.command === 'string';
  const cmd = typeof ti.command === 'string' ? ti.command : Array.isArray(ti.command) ? ti.command.join(' ') : '';
  const on = (key) => enforceLevel(cfg, key) !== 'off';

  // 1. Security: fail closed if the check itself throws.
  const guard = (fn) => { try { return fn(); } catch (err) { return { error: String(err.message || err) }; } };
  // Banned tool: only an actual call counts (its tool, its API host, or its SDK/MCP package). Searching the
  // web about it, or grepping for the word, is studying it and stays allowed (rules/research.md).
  const banned = cfg.bannedTool;
  if (banned && on('bannedTool')) {
    const r = guard(() => (!!banned.toolPattern && new RegExp(banned.toolPattern, 'i').test(name))
      || (!!banned.urlPattern && new RegExp(banned.urlPattern, 'i').test(typeof ti.url === 'string' ? ti.url : ''))
      || (!!banned.commandPattern && new RegExp(banned.commandPattern, 'i').test(cmd)));
    if (r === true || (r && r.error)) return { check: 'bannedTool', decision: 'deny', reason: `${banned.name || 'This tool'} is banned${banned.why ? ` (${banned.why})` : ''}: no direct call, no indirect call, no fallback. Use the host's web search instead.` };
  }
  if (on('bashSensitiveRead') && shell && cmd) {
    const r = guard(() => !KEY_ONLY.test(cmd) && touchesSensitive(name, { ...ti, command: cmd }, rc, true));
    if (r === true || (r && r.error)) return { check: 'bashSensitiveRead', decision: 'deny', reason: 'This command would read the raw value of a sensitive file (.env, private key, credentials). If you only need the variable names, use a key-only command such as `grep -o \'^[A-Za-z_][A-Za-z0-9_]*\' .env`; see rules/trust-and-secrets.md.' };
  }
  if (on('secretEgress')) {
    const r = guard(() => {
      if (shell && cmd && cfg.egressCommandPattern && cfg.secretVariablePattern) {
        if (new RegExp(cfg.egressCommandPattern, 'i').test(cmd) && new RegExp(cfg.secretVariablePattern).test(cmd)) return true;
      }
      return typeof ti.url === 'string' && SECRET_QUERY.test(ti.url);
    });
    if (r === true || (r && r.error)) return { check: 'secretEgress', decision: 'deny', reason: 'An outbound request carries what looks like a secret (a secret variable in the command, or a credential in the URL query). Under core.md "Untrusted input", credentials never go into URLs or outbound payloads; if the call is really needed, explain it and let the user run it.' };
  }

  // 2. Dangerous commands: ask the user first (fail open).
  if (on('dangerousCommands') && shell && cmd) {
    try {
      const hit = (cfg.dangerousCommandPatterns || []).find((p) => new RegExp(p, 'i').test(cmd));
      if (hit) return { check: 'dangerousCommands', decision: 'ask', reason: `This command is hard to undo or affects other people (matches ${hit}). Under rules/git-hygiene.md and core.md "Permissions and writes", the user confirms it first.` };
    } catch { /* fail open */ }
  }
  if (safetyOnly) return null;

  // 3. Scene-rule gate and reuse gate: need the transcript; fail open without it.
  try {
    const ctx = coverageContext({ cwd: input.cwd, scratchpadDir: input.scratchpad_dir, cfg });
    const call = { name, input: { ...ti, command: cmd || ti.command } };
    if (isRuleRead(call, ctx.inLibrary)) return null;

    // Project work: a file inside a real git repository that is not a tool config, rule file, the rule
    // library itself, the session scratchpad or the project's `.codex-temp/`. Needs update-logs, and is where
    // the analysis check looks.
    const target = typeof ti.file_path === 'string' ? ti.file_path.replace(/\\+/g, '/').toLowerCase() : '';
    let projectWrite = false;
    if ((on('sceneRuleGate') || on('analysisGate')) && (rc.writeTools || []).includes(name) && target && !ctx.inLibrary
      && !(ctx.scratch && target.startsWith(ctx.scratch)) && !PROJECT_TEMP.test(target) && !ctx.configPaths.some((re) => re.test(target))) {
      // git reports the long path while cwd may use the Windows short form (USERNA~1): accept either.
      const top = input.cwd ? toplevel(input.cwd) : null;
      const roots = top ? [top, input.cwd].map((p) => p.replace(/\\+/g, '/').toLowerCase().replace(/\/$/, '')) : [];
      projectWrite = roots.some((root) => target === root || target.startsWith(root + '/'));
    }
    const needed = [];
    if (on('sceneRuleGate')) {
      for (const t of classifyCall(call, ctx)) if (!t.memory && !isMustRule(cfg, t.rule)) needed.push(t);
      if (shell && GIT_RULE.test(cmd)) needed.push({ rule: 'rules/git-hygiene.md', why: 'a git operation' });
      if (shell && TEST_RULE.test(cmd)) needed.push({ rule: 'rules/testing-strategy.md', why: 'running tests' });
      if (projectWrite) needed.push({ rule: 'rules/update-logs.md', why: 'changing project files' });
    }
    const analysisCheck = projectWrite && on('analysisGate');
    const planTarget = reuseCandidate(name, ti, cfg);
    // Skill scripts: running a script inside a skill directory, or writing one that calls it, needs that
    // skill loaded (Skill tool or its SKILL.md read) in the recent prompts (rules/skill-selection.md).
    const scriptText = shell ? cmd : (rc.writeTools || []).includes(name) ? String(ti.content ?? ti.new_string ?? '') : '';
    const skillsRun = on('skillScriptGate') && rc.skillScriptPattern && scriptText ? skillScripts(scriptText, rc.skillScriptPattern, input.cwd) : [];
    if (!needed.length && !skillsRun.length && !(planTarget && on('reuseGate')) && !analysisCheck) return null;

    const tx = input.transcript_path ? readToolCalls(input.transcript_path, rc.maxTranscriptBytes || 20 * 1024 * 1024, rc.tailTranscriptBytes) : { status: 'no_transcript' };
    if (tx.status !== 'ok') return null;
    const size = rc.readWindowPrompts || 5;
    const calls = tx.calls.filter((c) => c.prompt >= Math.max(0, tx.prompts - size + 1));
    const turn = tx.prompts;
    // Deny-once key: the prompt's uuid when present, since a tail read renumbers prompts as the file
    // grows. A tail holding no prompt at all (one prompt longer than the tail) has no key: fail open.
    const key = tx.promptKey ?? (tx.truncated ? null : turn);
    if (key === null) return null;

    const unloaded = skillsRun.filter((s) => !calls.some((c) => loadsSkill(c, s))).filter((s) => !seen(input.session_id, `skill-${s}@${key}`, dir));
    if (unloaded.length) {
      for (const s of unloaded) mark(input.session_id, `skill-${s}@${key}`, dir);
      const list = unloaded.join(', ');
      return { check: 'skillScriptGate', decision: 'deny', once: true, reason: `This step runs a script from the skill ${list}, but the skill was not loaded in the recent prompts. Load it with the Skill tool or read its SKILL.md (${unloaded.map((s) => `${s}/SKILL.md`).join(', ')}), check its parameters, authorization and secret handling, then retry. This prompt will not be blocked again for the same skill.` };
    }

    const unread = [...new Map(needed.map((t) => [t.rule, t])).values()]
      .filter((t) => !calls.some((c) => readsRule(c, t.rule.split('/').pop(), ctx.inLibrary)))
      .filter((t) => !seen(input.session_id, `${t.rule}@${key}`, dir));
    if (unread.length) {
      for (const t of unread) mark(input.session_id, `${t.rule}@${key}`, dir);
      const list = unread.map((t) => `${t.rule} (${t.why})`).join(', ');
      return { check: 'sceneRuleGate', decision: 'deny', once: true, reason: `Read the scene rule first: ${list}, relative to the rule library (${ROOT.replace(/\\/g, '/')}). Adjust to it, then retry; this prompt will not be blocked again for the same rule.` };
    }

    if (planTarget && on('reuseGate')) {
      const re = new RegExp(cfg.reuseSearchPattern || 'gh\\s+search', 'i');
      const searched = tx.calls.filter((c) => c.prompt >= Math.max(0, turn - size + 1))
        .some((c) => re.test(`${c.name} ${JSON.stringify(c.input || {})}`));
      if (!searched && !seen(input.session_id, `reuse@${key}`, dir)) {
        mark(input.session_id, `reuse@${key}`, dir);
        return { check: 'reuseGate', decision: 'deny', once: true, reason: `About to write a plan or start a project (${planTarget}) with no reuse search in this task. Under rules/reuse-first.md, search local projects, installed skills and GitHub (gh search repos) first and put a reuse assessment in the plan; if the user said no search is needed, just retry.` };
      }
    }

    // Requirement analysis (rules/requirement-analysis.md): an implementation request whose answer has not
    // written its "Tier:" line yet is about to change project files. Last, so blocking checks come first;
    // in warn mode run() only logs it. Once per prompt.
    if (analysisCheck && classifyPrompt(tx.promptText, cfg).kind === 'implement'
      && !(tx.tiers || []).some((t) => t.prompt === turn) && !seen(input.session_id, `analysis@${key}`, dir)) {
      mark(input.session_id, `analysis@${key}`, dir);
      return { check: 'analysisGate', decision: 'deny', once: true, reason: 'This is an implementation request, but project files are about to change before the request was tiered. Tier it under rules/requirement-analysis.md and open the answer with "Tier: … | Why: …"; from "brief" up, stop and wait for the user; for "direct", restate the request in one line and retry. This prompt will not be blocked again for this.' };
    }
  } catch { /* fail open */ }
  return null;
}

// Read whitelist for the built-in read tools. Returns an 'ask' decision or null. Allowed without asking:
// the whitelist, the files of a skill loaded this session (Codex loads a skill by reading it, so any skill
// directory passes there), and paths the user named in the current request (not for subagents: their
// "request" is written by the parent model). A directory the user already let a read into during this
// prompt passes: an earlier read-tool call there that did not come back as an error (a rejection does).
// Without a transcript nothing can be proven, so it asks every time; errors ask rather than pass.
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'NotebookRead'];
export function readGate(input, { cfg, host: h }) {
  const name = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!cfg.readAllow || !READ_TOOLS.includes(name) || enforceLevel(cfg, 'readWhitelist') === 'off') return null;
  const ti = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const roots = (cfg.readAllow.roots || []).join(', ');
  const reason = (where) => `Reading outside the read whitelist: ${where}. Under core.md "Permissions and writes", reads stay within the working directory, the configured roots (${roots}), this session's temp files and subagent transcripts, each project's host memory and the skill in use; anything else needs the user's consent. A directory allowed earlier in this prompt is not asked again; after a refusal, do not route around it with another tool or path.`;
  try {
    const wl = readWhitelist({ cwd: input.cwd, sessionId: input.session_id, scratchpadDir: input.scratchpad_dir, cfg });
    const outsideOf = (tool, args) => readTargets(tool, args, input.cwd).map((t) => ({ p: realPath(t, input.cwd) }))
      .map((o) => ({ ...o, place: readPlace(o.p, wl) }))
      .filter(({ place }) => place !== 'in' && !(place.skill && h !== 'claude'));
    const outside = outsideOf(name, ti);
    if (!outside.length) return null;
    const rc = cfg.ruleCoverage || {};
    const tx = input.transcript_path ? readToolCalls(input.transcript_path, rc.maxTranscriptBytes || 20 * 1024 * 1024, rc.tailTranscriptBytes) : { status: 'no_transcript' };
    const ok = tx.status === 'ok' && !(tx.truncated && !tx.prompts);
    const sub = !!(input.agent_id || input.agent_type);
    const loaded = ok ? tx.calls.filter((c) => c.name === 'Skill').map((c) => String(c.input.skill || '').split(':').pop().toLowerCase()) : [];
    const dirOf = (p) => { try { return fs.statSync(p).isDirectory() ? p : path.posix.dirname(p); } catch { return path.posix.dirname(p); } };
    // Directories earlier read calls of this prompt got into without an error.
    const granted = new Set(ok ? tx.calls.filter((c) => c.prompt === tx.prompts && READ_TOOLS.includes(c.name) && !(c.id && tx.failed.has(c.id)))
      .flatMap((c) => outsideOf(c.name, c.input).map(({ p }) => dirOf(p))) : []);
    const left = outside.filter(({ p, place }) => !(place.skill && loaded.includes(place.skill))
      && !(ok && !sub && namedInPrompt(tx.promptText, p)) && !granted.has(dirOf(p)));
    if (!left.length) return null;
    return { check: 'readWhitelist', decision: 'ask', reason: reason([...new Set(left.map(({ p }) => dirOf(p)))].join(', ')) };
  } catch (err) {
    return { check: 'readWhitelist', decision: 'ask', reason: reason(`(path could not be judged: ${String(err && err.message || err).slice(0, 120)})`) };
  }
}
function readTargets(name, ti, cwd) {
  if (name === 'Read' || name === 'NotebookRead') return [ti.file_path || ti.notebook_path].filter((x) => typeof x === 'string' && x);
  const base = typeof ti.path === 'string' && ti.path ? ti.path : cwd;
  const out = [base].filter(Boolean);
  // A Glob pattern can leave its base ("../x/*", "/Users/x/*", "C:/x/*"): its literal directory prefix,
  // resolved against the base, is listed too.
  const pat = name === 'Glob' && typeof ti.pattern === 'string' ? ti.pattern.replace(/\\+/g, '/') : '';
  const prefix = pat.split(/[*?[{]/)[0];
  const lit = prefix.includes('/') ? prefix.replace(/\/[^/]*$/, '') || '/' : '';
  if (lit) out.push(/^(?:[a-z]:\/|\/|~\/)/i.test(lit) ? lit : `${String(base).replace(/[\\/]+$/, '')}/${lit}`);
  return out;
}
// Shell reads outside the whitelist: observation only (paths in a command are a guess).
function logShellReads(input, { cfg, dir, host: h }) {
  if (!cfg.readAllow || enforceLevel(cfg, 'readWhitelistShell') === 'off') return;
  const ti = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const cmd = typeof ti.command === 'string' ? ti.command : Array.isArray(ti.command) ? ti.command.join(' ') : '';
  if (!cmd) return;
  try {
    const wl = readWhitelist({ cwd: input.cwd, sessionId: input.session_id, scratchpadDir: input.scratchpad_dir, cfg });
    const targets = shellReadPaths(cmd).map((t) => realPath(t, input.cwd)).filter((p) => readPlace(p, wl) === 'out');
    if (targets.length) appendLog({ host: h, event: 'PreToolUse', session: input.session_id, tool: input.tool_name, check: 'readWhitelistShell', decision: 'logged', targets: targets.slice(0, 5) }, dir);
  } catch { /* observation only */ }
}

// A plan file (hooks.planPathPatterns) or a project init file created in a directory that has none yet.
function reuseCandidate(name, ti, cfg) {
  const rc = cfg.ruleCoverage || {};
  if (!(rc.writeTools || ['Write', 'Edit']).includes(name) || typeof ti.file_path !== 'string') return null;
  const p = ti.file_path.replace(/\\+/g, '/');
  if ((cfg.planPathPatterns || []).some((re) => new RegExp(re, 'i').test(p))) return p;
  if (name === 'Write' && (cfg.projectInitFiles || []).includes(path.posix.basename(p)) && !fs.existsSync(ti.file_path)) return p;
  return null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Skill names whose scripts the text refers to, except the skill whose own directory is the cwd
// (maintaining a skill runs its scripts all the time).
function skillScripts(text, pattern, cwd) {
  const here = String(cwd || '').replace(/\\+/g, '/').toLowerCase();
  const names = new Set([...String(text).matchAll(new RegExp(pattern, 'gi'))].map((m) => m[1]));
  return [...names].filter((s) => !new RegExp(`/skills/+${esc(s.toLowerCase())}(/|$)`).test(here));
}
// A call that loads the skill: the Skill tool, or a read of its SKILL.md.
function loadsSkill(c, s) {
  if (c.name === 'Skill') { const k = String(c.input.skill || ''); return k === s || k.endsWith(`:${s}`); }
  const file = new RegExp(`[\\\\/]${esc(s)}[\\\\/]+SKILL\\.md\\b`, 'i');
  if (c.name === 'Read') return file.test(String(c.input.file_path || ''));
  return typeof c.input.command === 'string' && SENSITIVE_READ_VERB.test(c.input.command) && file.test(c.input.command);
}

function flag(sessionId, key, dir) {
  const sid = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, 'sessions', sid, 'gate', key.replace(/[^A-Za-z0-9_.@-]/g, '_'));
}
function seen(sessionId, key, dir) { return fs.existsSync(flag(sessionId, key, dir)); }
function mark(sessionId, key, dir) {
  try { const f = flag(sessionId, key, dir); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString()); } catch { /* ignore */ }
}

export function run(input, { cfg = loadHookConfig(), dir = stateDir(), host: h = host } = {}) {
  if (hooksDisabled()) return null;
  logShellReads(input, { cfg, dir, host: h });
  // The read whitelist and the security checks bind subagents too; the process gates leave them to their
  // parent's rules. A deny from the other checks outranks the whitelist's ask.
  const r = readGate(input, { cfg, host: h });
  const other = decide(input, { cfg, dir, host: h, safetyOnly: !!(input.agent_id || input.agent_type) });
  const d = other && other.decision === 'deny' ? other : (r || other);
  if (!d) return null;
  const level = enforceLevel(cfg, d.check);
  // Codex's PreToolUse only supports deny; its own approval policy handles risky commands.
  const effective = level !== 'enforce' || (d.decision === 'ask' && h !== 'claude') ? 'logged' : d.decision;
  appendLog({ host: h, event: 'PreToolUse', session: input.session_id, tool: input.tool_name, check: d.check, decision: effective }, dir);
  if (effective === 'logged') return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: `[rules-as-code: blocked] ${d.reason}` } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = loadHookConfig();
  const killer = setTimeout(() => process.exit(0), cfg.budgetMs + 3000);
  try {
    const out = run(await readStdinJson(), { cfg });
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    appendLog({ host, event: 'PreToolUse', error: String(err && err.message || err).slice(0, 300) });
  }
  clearTimeout(killer);
  process.exit(0);
}
