// Shared logic for the closing-check and session-baseline hooks.
// Hooks must never break a session: every public function fails open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadHookConfig(root = ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'adapters.json'), 'utf8')).hooks;
  } catch {
    return { mode: 'warn', changedLinesThreshold: 700, budgetMs: 5000, maxDirtyFiles: 2000, defaultLogDir: 'update logs' };
  }
}

export function stateDir(root = ROOT) {
  return process.env.AGENT_PROMPTS_STATE_DIR || path.join(root, '.state');
}

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
  return raw.trim() ? JSON.parse(raw) : {};
}

export function hooksDisabled() {
  return /^(off|0|false|disabled)$/i.test(process.env.AGENT_PROMPTS_HOOKS || '');
}

export function appendLog(record, dir = stateDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch { /* logging must not fail the hook */ }
}

// ---------- closing tail ----------

const LABEL_MISSED = /\*\*(我可能遗漏了什么|What I might have missed)\*\*/i;
const LABEL_ASK = /\*\*(追问|Follow-up questions?)\*\*/i;

export function isMachineOutput(msg) {
  const t = msg.trim();
  if (/^[[{]/.test(t)) { try { JSON.parse(t); return true; } catch { /* not pure JSON */ } }
  if (/^(diff --git|--- a\/|\*\*\* Begin Patch)/.test(t)) return true;
  if (/^```[^\n]*\n[\s\S]*\n```$/.test(t) && (t.match(/```/g) || []).length === 2) return true;
  return false;
}

// A turn that pauses while delegated work is in flight is a progress update, not a final answer
// (rules/output-and-closing.md exempts those). Claude Code lists in-flight work in `background_tasks`.
// Only task types that wake the session with a result count: a long-running shell task such as a
// dev server can stay alive across real final answers, so it is not a pause signal by itself.
const WAKING_TASK_TYPES = /^(subagent|workflow|teammate|cloud session|mcp task)$/i;

export function waitingOnBackground(input) {
  const tasks = Array.isArray(input && input.background_tasks) ? input.background_tasks : [];
  return tasks.some((t) => t && typeof t.type === 'string' && WAKING_TASK_TYPES.test(t.type.trim()));
}

// Fallback for hosts or versions without `background_tasks` (Codex, older Claude Code): a short
// message with no closing labels whose ending says it is waiting for delegated work to report back.
// Phrases are anchored to waiting-on-others wording so a short real answer such as "fixed: the result was
// read before the Promise resolved" is still checked; long answers are never exempted. The Chinese
// phrasings are aliases.
const WAITING_PHRASE = new RegExp([
  '(还在|仍在|正在)等',
  '等(它|它们|其余|剩下|这些|其他|另外)[^。\\n]{0,12}(返回|跑完|结束|完成)',
  '还剩[^。\\n]{0,40}(子代理|代理|agent)',
  '(子代理|agents?)[^。\\n]{0,10}(还在|仍在)(运行|进行|执行)',
  '(返回|完成|结束|回来)后[，,]?\\s*我(会|再)',
  '完成后(会)?(自动)?通知',
  'waiting (for|on) (the )?(\\w+ )?(sub-?agents?|agents?|background|results?)',
  '(sub-?agents?|agents?|tasks?) (are|is) still running',
  "(I will|I'll) report back",
].join('|'), 'i');

export function looksLikeProgressUpdate(msg) {
  const t = typeof msg === 'string' ? msg.trim() : '';
  if (!t || t.length > 600 || LABEL_MISSED.test(t) || LABEL_ASK.test(t)) return false;
  return WAITING_PHRASE.test(t.slice(-300));
}

export function checkTail(msg) {
  const tail = msg.slice(-600);
  const missed = LABEL_MISSED.test(tail);
  const askMatch = tail.match(LABEL_ASK);
  const hasQuestion = askMatch ? /[？?]/.test(tail.slice(askMatch.index + askMatch[0].length)) : false;
  if (missed && askMatch && hasQuestion) return null;
  if (!missed && !askMatch && /[？?]\s*$/.test(msg.trim())) return null; // turn ends by asking the user something
  const missing = [];
  if (!missed) missing.push('"What I might have missed"');
  if (!askMatch) missing.push('"Follow-up questions"');
  else if (!hasQuestion) missing.push('a concrete follow-up question (ending with a question mark)');
  return `The closing is missing ${missing.join(' and ')}. Add both closing sections as core.md "Closing" requires.`;
}

// ---------- rule coverage ----------
// Which on-demand rules the session's own tool calls made mandatory, and whether any call read them.
// Source: the host transcript (JSONL). It is written asynchronously, so the newest calls of the current
// turn may be missing; results are advisory. Every failure returns a status instead of throwing.

const norm = (s) => String(s).replace(/\\+/g, '/').toLowerCase();
const within = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
// The rule library: wherever this repo lives, plus the conventional install location ~/.agents/prompts.
const PROMPTS_MARK = '.agents/prompts';
const LIBRARY_ROOT = norm(ROOT);
const inLibraryPath = (text) => text.includes(PROMPTS_MARK) || within(text, LIBRARY_ROOT) || text.includes(LIBRARY_ROOT + '/');
// Completion claims in the usual phrasings, including test results such as "7 pass". The library was tuned
// on Chinese sessions, so the Chinese phrasings stay as aliases ("已完成", "测试全部通过").
// English: a state verb with the participle ("is fixed", "has been verified"), but not "implemented in …" or
// "fixed-width"; "done" opening a line; "<the fix|implementation|…> complete(d)"; test counts.
const CLAIM = /\b(?:is|are|now|has been|have been|was|were|I've|I have|we've|we have)\s+(?:(?:fully|now|all)\s+)?(?:fixed|verified|implemented|completed|done)\b(?![-\w])(?!\s+(?:in|by|as|on|with|via|using|through)\b)|^\s*done\b|\b(?:fix|implementation|change|task|work|migration|refactor)\s+(?:is\s+)?(?:complete|completed|done)\b|\ball (?:tests? )?pass(?:ed)?\b|\b[1-9]\d*\s*pass(?:ed)?\b|已完成|已修复|已验证|实现完成|修复完成|测试(?:已|都|全部)?通过/gim;
const NEGATION_CJK = /不|未|没|别|能否|是否/;
// An English negation counts only within three words of the claim ("not fixed yet", "can't say all tests pass"),
// so "no warnings, and all tests passed" stays a claim.
const NEGATION_EN = /\b(?:not|never|cannot|can't|isn't|aren't|wasn't|weren't|haven't|hasn't|didn't|doesn't|don't|won't|yet to|no longer)\s+(?:[\w'-]+\s+){0,3}$/i;
// A condition or an instruction in the same clause ("if the tests pass", "make sure tests pass").
const CONDITION_EN = /\b(?:if|whether|unless|until|once|make sure|ensure|so that|to see|check that|verify that)\b[^,;:]*$/i;
export const INDEX_RULE = 'INDEX.md';

// Negated: a CJK negation in the six characters before the match, an English negation just before it, or an
// English condition earlier in the same clause.
function negated(t, index) {
  const cjk = t.slice(Math.max(0, index - 6), index).split(/[。！？\n]/).pop();
  const en = t.slice(Math.max(0, index - 40), index).split(/[.!?。！？\n]/).pop();
  return NEGATION_CJK.test(cjk) || NEGATION_EN.test(en) || CONDITION_EN.test(en);
}

// A completion claim that is not negated ("not verified yet", "还没验证" do not count).
export function hasCompletionClaim(msg) {
  const t = typeof msg === 'string' ? msg : '';
  for (const m of t.matchAll(CLAIM)) if (!negated(t, m.index)) return true;
  return false;
}

// A claim that checks passed ("all three QA runs passed", "0 errors", "85/85 passed"). An answer that already
// says the result predates the last change ("passed before the last edit, not re-run") is qualified.
const PASS = /\ball (?:\w+ ){0,3}(?:tests?|checks?|runs?|suites?) (?:pass(?:ed)?|(?:are |were )?green)\b|\b(?:tests?|checks?|build|lint|typecheck) (?:pass(?:ed|es)?|succeeded|(?:is |are )?green)\b|\b0 errors\b|\ball green\b|\ball (?:tests? )?pass(?:ed)?\b|\b\d+\s*\/\s*\d+\s*(?:通过|pass(?:ed)?)|\b[1-9]\d*\s*pass(?:ed)?\b|全部通过|都通过|均通过|测试(?:已)?通过|检查通过|构建通过|巡检.{0,6}通过|0\s*(?:个)?错误|零错误|全绿/gi;
const QUALIFIED = /not re-?run|before the (?:last )?(?:change|edit)|未重跑|没有重跑|没重跑|改动前通过/i;
export function claimsPassing(msg) {
  const t = typeof msg === 'string' ? msg : '';
  if (QUALIFIED.test(t)) return false;
  for (const m of t.matchAll(PASS)) if (!negated(t, m.index)) return true;
  return false;
}

// A real user prompt: not a tool result, not host metadata, not a compaction summary.
function isUserPrompt(o) {
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary) return false;
  if (o.origin && o.origin.kind === 'task-notification') return false; // host-injected, not typed by the user
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c.trim().length > 0 && !c.trimStart().startsWith('<task-notification>');
  return Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result') && c.some((b) => b && b.type === 'text' && b.text.trim());
}

// The last `bytes` of a file as complete lines (a cut first line is dropped); [] when unreadable.
export function tailLines(file, bytes) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  const n = Math.min(bytes, size);
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf8');
  if (n < size) text = text.slice(text.indexOf('\n') + 1);
  return text.split('\n').filter((l) => l.trim());
}

// The session's current model tier as the transcript recorded it for the last answer: a Claude assistant
// record carries `effort` and `message.model`, a Codex turn_context carries `payload.model` and
// `payload.effort` (or its collaboration settings). Values must look like a model id and an effort level,
// so a hostile record cannot smuggle text into the context. null when nothing qualifies.
const EFFORT_RE = /^[a-z][a-z0-9-]{0,15}$/;
const MODEL_RE = /^[a-z][a-z0-9.-]{1,40}$/;
export function sessionTier(file, host, bytes = 256 * 1024) {
  if (typeof file !== 'string' || !file) return null;
  const lines = tailLines(file, bytes);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (host === 'codex' ? !line.includes('"turn_context"') : !line.includes('"assistant"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    let model; let effort;
    if (host === 'codex' && o.type === 'turn_context' && o.payload) {
      const p = o.payload;
      model = p.model;
      effort = p.effort || p.reasoning_effort || (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort);
    } else if (host !== 'codex' && o.type === 'assistant') {
      model = o.message && o.message.model;
      if (model === '<synthetic>') continue; // host-made records carry no tier
      effort = o.effort;
    } else continue;
    // The latest record decides: invalid or missing values mean "unknown", not an older tier.
    return typeof model === 'string' && MODEL_RE.test(model) && typeof effort === 'string' && EFFORT_RE.test(effort) ? { model, effort } : null;
  }
  return null;
}

// Subagents started in the current turn, counted by role (rules/delegation.md, observation only), and
// whether the answer carries the "Delegation:" line. Claude: Agent/Task calls after the last user prompt,
// keyed by subagent_type (none = general-purpose). Codex: spawn_agent calls after the last user message,
// keyed by the agent named in the arguments (none = default).
// The bold model-tier line every answer opens with (rules/delegation.md "Session model tier").
// Chinese labels (模型档, 分工) are aliases from the sessions the hooks were tuned on.
export const MODEL_TIER_LINE = /^\s*(?:\*\*)?(?:Model tier|模型档)(?:\*\*)?[：:]/imu;
export const SPLIT_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Delegation|分工)(?:\*\*)?[：:]/imu;
export function turnDelegation(file, host, lastMessage = '', { maxBytes = 20 * 1024 * 1024, tailBytes = 2 * 1024 * 1024 } = {}) {
  const agents = {};
  const add = (k) => { agents[k] = (agents[k] || 0) + 1; };
  if (host === 'codex') {
    let calls = [];
    for (const line of tailLines(file, tailBytes)) {
      const user = line.includes('"role":"user"');
      if (!user && !line.includes('"function_call"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload || {};
      if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        // Host-injected messages (<environment_context>, <send_user_message_question_reply>, …) stay in the turn.
        const text = Array.isArray(p.content) ? p.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : '';
        if (!text.trimStart().startsWith('<')) calls = [];
        continue;
      }
      if (o.type === 'response_item' && p.type === 'function_call' && p.name === 'spawn_agent') calls.push(p.arguments);
    }
    for (const raw of calls) {
      let a = {}; try { a = typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch { a = {}; }
      const k = [a.agent_type, a.agent, a.agent_name, a.role].find((v) => typeof v === 'string' && /^[A-Za-z][\w-]{0,40}$/.test(v));
      add(k || 'default');
    }
  } else {
    const tx = readToolCalls(file, maxBytes, tailBytes);
    if (tx.status === 'ok') {
      for (const c of tx.calls) {
        if (c.prompt !== tx.prompts || (c.name !== 'Agent' && c.name !== 'Task')) continue;
        const t = c.input && c.input.subagent_type;
        add(typeof t === 'string' && /^[A-Za-z][\w-]{0,40}$/.test(t) ? t : 'general-purpose');
      }
    }
  }
  return { agents, split: SPLIT_LINE.test(typeof lastMessage === 'string' ? lastMessage : '') };
}

// Tool calls since the last compaction, each tagged with the number of user prompts seen so far.
// A transcript over maxBytes is read from its last tailBytes only (truncated: true); prompt numbers
// then count from the tail start, so callers that need a stable per-prompt key use promptKey.
export function readToolCalls(file, maxBytes, tailBytes = 0) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { status: 'no_transcript' }; }
  let text;
  const truncated = size > maxBytes;
  if (truncated) {
    if (!tailBytes) return { status: 'too_large' };
    const n = Math.min(tailBytes, size);
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
    if (n < size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
  } else {
    text = fs.readFileSync(file, 'utf8');
  }
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return { status: 'empty' };
  try { if (typeof JSON.parse(lines[0]).type !== 'string') return { status: 'format_unknown' }; } catch { return { status: 'format_unknown' }; }
  const calls = [];
  const tiers = []; // "Tier: …" lines the assistant wrote (rules/requirement-analysis.md)
  const failed = new Set(); // tool_use ids whose result is an error
  let prompt = 0;
  let promptKey = null;
  let promptText = '';
  for (const line of lines) {
    const maybePrompt = line.includes('"type":"user"');
    const maybeTier = line.includes('"type":"assistant"') && (/tier/i.test(line) || line.includes('分档') || line.includes('\\u5206\\u6863'));
    if (!maybePrompt && !maybeTier && !line.includes('"tool_use"') && !line.includes('"compact_boundary"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'compact_boundary') { calls.length = 0; continue; } // tiers survive: the answer already chose one
    if (maybePrompt && isUserPrompt(o)) {
      prompt += 1;
      promptKey = typeof o.uuid === 'string' ? o.uuid : null;
      promptText = promptTextOf(o).slice(0, 2000);
      continue;
    }
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_use' && typeof b.name === 'string') calls.push({ name: b.name, input: b.input ?? {}, prompt, id: b.id });
      if (o.type === 'assistant' && b && b.type === 'text') { const t = tierOf(b.text); if (t) tiers.push({ prompt, tier: t }); }
      // Failed or rejected calls ("The user doesn't want to proceed…" is an error result).
      if (b && b.type === 'tool_result' && b.is_error && b.tool_use_id) failed.add(b.tool_use_id);
    }
  }
  return { status: 'ok', calls, prompts: prompt, promptKey, promptText, tiers, failed, truncated };
}
const promptTextOf = (o) => {
  const c = o.message && o.message.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
};

// The tier line every answer starts with under rules/requirement-analysis.md: "Tier: brief | Why: …".
// Returns the canonical English tier name; the Chinese tier names are aliases.
const TIERS = { direct: 'direct', brief: 'brief', 'full analysis': 'full analysis', 'design first': 'design first', probe: 'probe',
  research: 'research', 直接做: 'direct', 简析: 'brief', 完整分析: 'full analysis', 设计先行: 'design first', 探针: 'probe', 调研与内容: 'research' };
const TIER_LINE = /^\s*(?:[-*>]\s*)?\**\s*(?:Tier|分档)\**\s*[：:]\s*\**\s*(direct|brief|full analysis|design[- ]first|probe|research|直接做|简析|完整分析|设计先行|探针|调研与内容)(?![\w-])/im;
export function tierOf(text) {
  const m = typeof text === 'string' ? text.match(TIER_LINE) : null;
  return m ? TIERS[m[1].toLowerCase().replace('-', ' ')] : null;
}
// Rough count of questions put to the user: non-code lines ending in a question mark.
export function countQuestions(text) {
  const t = (typeof text === 'string' ? text : '').replace(/^```[\s\S]*?^```/gm, '');
  return t.split('\n').filter((l) => /[？?]\s*$/.test(l.trim())).length;
}

// Keyword match: ASCII keywords as whole words, CJK keywords as substrings.
export function matchesAny(text, keywords) {
  const t = String(text || '');
  return (keywords || []).some((k) => {
    if (/^[\x20-\x7e]+$/.test(k)) {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i').test(t);
    }
    return t.includes(k);
  });
}

// What a user prompt asks for, for rules/requirement-analysis.md: skip (do it / run an approved plan),
// analysis (analyze or plan only), implement, or other; plus whether it signals rework of earlier output.
export function classifyPrompt(prompt, cfg) {
  const p = String(prompt || '');
  const kind = matchesAny(p, cfg.skipAnalysisKeywords) ? 'skip'
    : matchesAny(p, cfg.analysisOnlyKeywords) ? 'analysis'
      : matchesAny(p, cfg.implementPromptKeywords) ? 'implement' : 'other';
  return { kind, rework: matchesAny(p, cfg.reworkPromptKeywords) };
}

// Shared context for classifying calls: repo roots, exempt write locations and path patterns.
export function coverageContext({ cwd, scratchpadDir, cfg, home = os.homedir() }) {
  const rc = (cfg && cfg.ruleCoverage) || {};
  const expandHome = (d) => d.replace(/^~(?=[\\/]|$)/, home);
  return {
    rc,
    // The repo root as git reports it and as the host spells cwd (Windows short and long names can differ).
    repoRoots: cwd ? [...new Set([norm(toplevel(cwd) || cwd), norm(cwd)])] : [],
    exempt: [scratchpadDir, os.tmpdir(), ...(rc.writeExemptDirs || []).map(expandHome)].filter(Boolean).map(norm),
    scratch: scratchpadDir ? norm(scratchpadDir) : null,
    cwd: cwd ? norm(cwd) : null,
    configPaths: (rc.configPathPatterns || []).map((p) => new RegExp(p, 'i')),
    memoryPath: rc.memoryPathPattern ? new RegExp(rc.memoryPathPattern, 'i') : null,
    inLibrary: !!cwd && inLibraryPath(norm(cwd)),
  };
}

// Rules one tool call makes mandatory: [{ rule, why }]. Memory writes are reported as { memory: true }.
export function classifyCall({ name: n, input }, ctx) {
  const { rc } = ctx;
  const out = [];
  const has = (list) => (list || []).includes(n);
  const starts = (list) => (list || []).some((p) => n.startsWith(p));
  if (has(rc.searchTools)) out.push({ rule: 'rules/research.md', why: n });
  else if (starts(rc.browserPrefixes)) out.push({ rule: 'rules/browser-automation.md', why: n });
  else if (n.startsWith('mcp__') && !starts(rc.mcpIgnorePrefixes)) out.push({ rule: 'rules/external-tools-mcp.md', why: n });
  const file = input && (input.file_path || input.notebook_path);
  const shell = has(rc.shellTools) && input && typeof input.command === 'string';
  if (touchesSensitive(n, input, rc, shell)) out.push({ rule: 'rules/trust-and-secrets.md', why: `${n} reads a sensitive file` });
  const targets = has(rc.writeTools) && typeof file === 'string' ? [norm(file)] : shell ? shellWriteTargets(input.command, ctx.cwd) : [];
  const via = shell ? `${n} command` : n;
  for (const p of targets) {
    if (ctx.memoryPath && ctx.memoryPath.test(p)) {
      out.push({ memory: true, why: `${via} writes long-term memory` });
    } else if (!(ctx.scratch && within(p, ctx.scratch)) && ctx.configPaths.some((re) => re.test(p))) {
      // Tool configs, rule files and entry files count wherever they live, inside the repo or not.
      out.push({ rule: 'rules/trust-and-secrets.md', why: `${via} writes a config or rule file` }, { rule: 'rules/change-integrity.md', why: `${via} writes a config or rule file` });
    } else if (ctx.repoRoots.length && !ctx.repoRoots.some((r) => within(p, r)) && !ctx.exempt.some((r) => within(p, r))) {
      out.push({ rule: 'rules/trust-and-secrets.md', why: `${via} writes outside the repo` });
    }
    if (shell && STRUCTURED.test(p)) out.push({ rule: 'rules/commands-and-encoding.md', why: `${n} command writes structured text` });
  }
  return out;
}

// Files a shell command writes, resolved against a leading `cd` or the session cwd. Heuristic: covers
// redirection (`>`, `>>`, heredocs), tee, PowerShell Set-/Add-Content and Out-File, cp/mv/Copy-Item/Move-Item
// destinations, and inline writeFileSync / WriteAllText calls. Null devices and fd redirects are ignored.
const STRUCTURED = /\.(md|markdown|json|jsonl|ya?ml|toml|csv|xml|html?|ini)$/i;
const PATH_ARG = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s;|&<>()]+))`;
const WRITE_PATTERNS = [
  new RegExp(String.raw`(?:^|[^0-9&>=])>>?\s*` + PATH_ARG, 'g'),
  new RegExp(String.raw`\btee\s+(?:-a\s+)?` + PATH_ARG, 'gi'),
  new RegExp(String.raw`\b(?:set-content|add-content|out-file)\b(?:\s+-(?:literalpath|filepath|path|encoding\s+\S+))*\s+` + PATH_ARG, 'gi'),
  new RegExp(String.raw`\b(?:cp|mv|copy-item|move-item)\s+(?:-\S+\s+)*\S+\s+(?:-destination\s+)?` + PATH_ARG, 'gi'),
  new RegExp(String.raw`(?:writefilesync|appendfilesync|writealltext|appendalltext)\(\s*` + PATH_ARG.replace('[^\\s;|&<>()]+', '[^\\s,)]+'), 'gi'),
];
const NULL_TARGET = /^(\/dev\/null|nul|\$null|&\d|\d)$/i;
// Sensitive files (secrets, keys, credentials, auth state) touched by a read-type tool or named as a path
// token in a shell command. Only the file name is matched, so `process.env.X` or a SKILL.md about secrets
// hygiene do not count; heredoc bodies are ignored. Templates such as `.env.example` are allowed.
// Shell commands count only with a read verb. Globs and regexes (`**/.env`, `\.env$`) are patterns, not
// reads. A path built from a variable (`$TEMP/x/.env`, `%USERPROFILE%\.ssh\id_rsa`, `${HOME}/.env`) still
// counts when its last segment is a literal sensitive file name: the variable only hides the directory.
// .NET file reads (`[IO.File]::ReadAllText(...)`) count too: that is how a DPAPI key file was decrypted by hand.
export const SENSITIVE_READ_VERB = /(^|[\s;&|(])(cat|type|get-content|gc|sed|head|tail|less|more|nl|awk|grep|rg|select-string|source|cut|strings|xxd|od|base64|cp|copy-item)(\s|$)|::ReadAll(Text|Bytes|Lines)\s*\(/i;
export function touchesSensitive(n, input, rc, shell) {
  if (!rc.sensitivePathPattern || !input) return false;
  const name = new RegExp(rc.sensitivePathPattern, 'i');
  const full = rc.sensitiveFullPathPattern ? new RegExp(rc.sensitiveFullPathPattern, 'i') : null;
  const hit = (p) => typeof p === 'string' && p !== '' && (name.test(norm(p).split('/').pop()) || (!!full && full.test(norm(p))));
  if ((rc.readTools || []).includes(n)) return hit(input.file_path) || hit(input.path) || hit(input.notebook_path);
  if (!shell) return false;
  const body = stripLiteralBodies(input.command);
  if (!SENSITIVE_READ_VERB.test(body)) return false;
  return body.split(/[\s"'`;|&<>()=,]+/).some((t) => {
    if (!t || /[*?[\]|^]/.test(t)) return false; // glob or regex: a pattern, not a path
    if (!/[${}%]/.test(t)) return hit(t);
    // Variable-built path: judge the literal tail after the last separator.
    const segs = t.replace(/\\+/g, '/').split('/');
    const last = segs.pop();
    if (!last || /[${}%]/.test(last)) return false;
    // A literal directory right before it (`$HOME/.ssh/id_rsa`) keeps the full-path rules working too.
    const tail = segs.filter((s) => s && !/[${}%]/.test(s)).concat(last).join('/');
    return hit(last) || hit('/' + tail);
  });
}

// Heredoc bodies are file content, not commands: keep the header line (which holds the redirect), drop the body.
const HEREDOC = /(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n[\s\S]*?\n\s*\3\s*(?=\n|$)/g;
// PowerShell here-strings (@'…'@, @"…"@) are literal text in the same way.
const HERESTRING = /@(['"])\r?\n[\s\S]*?\r?\n\1@/g;
const stripLiteralBodies = (command) => String(command).replace(HEREDOC, '$1').replace(HERESTRING, "''");
// Inline script bodies (`node -e '…'`, `python -c "…"`) are code whose strings may name a check without running
// it. Only the stale-verification check drops them: the write and sensitive-read checks must still see them.
const INLINE_SCRIPT = /(\b(?:node|python3?|py|deno|bun)(?:\.exe)?\s+(?:-e|-c|-p|--eval|--print)\s+)(['"])(?:\\[\s\S]|(?!\2)[\s\S])*\2/gi;
const stripInlineScripts = (command) => String(command).replace(INLINE_SCRIPT, "$1''");
export function shellWriteTargets(command, cwd) {
  const cmd = stripLiteralBodies(command);
  const cd = cmd.match(new RegExp(String.raw`^\s*(?:cd|set-location|pushd)\s+` + PATH_ARG, 'i'));
  const base = cd ? (cd[1] || cd[2] || cd[3]) : cwd;
  const out = new Set();
  for (const re of WRITE_PATTERNS) {
    for (const m of cmd.matchAll(re)) {
      const raw = (m[1] || m[2] || m[3] || '').replace(/^['"]|['"]$/g, '');
      if (!raw || NULL_TARGET.test(raw) || /^[$=<-]/.test(raw)) continue;
      out.add(resolveShellPath(raw, base));
    }
  }
  return [...out];
}
function absolutePath(p) {
  let s = String(p).replace(/\\+/g, '/');
  if (/^~(\/|$)/.test(s)) s = os.homedir().replace(/\\+/g, '/') + s.slice(1);
  const drive = s.match(/^\/([a-z])(\/.*|)$/i); // Git Bash style /c/Users/...
  if (drive) s = `${drive[1]}:${drive[2] || '/'}`;
  return s;
}
function resolveShellPath(p, base) {
  let s = absolutePath(p);
  if (!/^[a-z]:\//i.test(s) && !s.startsWith('/') && base) s = absolutePath(base).replace(/\/$/, '') + '/' + s.replace(/^\.\//, '');
  return norm(s);
}

// ---------- read whitelist (core.md "Permissions and writes") ----------
// Paths compare after realpath, so Windows short names (USERNA~1), junctions and symlinks resolve to where
// the bytes really are. A path that does not exist yet resolves through its nearest existing parent.
export function realPath(p, base) {
  let s = absolutePath(p);
  if (!/^[a-z]:\//i.test(s) && !s.startsWith('/') && base) s = absolutePath(base).replace(/\/$/, '') + '/' + s.replace(/^\.\//, '');
  s = path.posix.normalize(s); // "a/missing/../.." must not stay inside "a"
  let cur = s;
  let rest = '';
  for (let i = 0; i < 64; i += 1) {
    try { return norm(fs.realpathSync.native(cur)).replace(/\/$/, '') + norm(rest); } catch { /* walk up */ }
    let parent = path.posix.dirname(cur);
    if (/^[a-z]:$/i.test(parent)) parent += '/';
    if (parent === cur || parent === '.') break;
    rest = '/' + path.posix.basename(cur) + rest;
    cur = parent;
  }
  return norm(s).replace(/\/$/, '');
}
// cfg.readAllow: { roots, sessionRoots, skillRoots }; "~" is the home directory, "{tmp}" the system temp.
// The working directory (as the call reports it and as the session started, CLAUDE_PROJECT_DIR) and the
// scratchpad always count; session roots only under a directory named after this session; skill roots
// only for the skill in use (decided by the caller).
// readAllow.memoryRoots: the host's auto-memory of every project, "<root>/<project>/memory/" only (the
// transcripts and tool results beside it stay outside).
export function readWhitelist({ cwd, sessionId, scratchpadDir, cfg, home = os.homedir(), projectDir = process.env.CLAUDE_PROJECT_DIR }) {
  const ra = cfg.readAllow || {};
  const real = (d) => realPath(String(d).replace(/^\{tmp\}/, os.tmpdir()).replace(/^~(?=[\\/]|$)/, home));
  return {
    memoryRoots: (ra.memoryRoots || []).map(real),
    roots: [cwd, projectDir, scratchpadDir, ...(ra.roots || [])].filter(Boolean).map(real),
    sessionRoots: (ra.sessionRoots || []).map(real),
    skillRoots: (ra.skillRoots || []).map(real),
    session: sessionId ? String(sessionId).toLowerCase() : null,
  };
}
// 'in', 'out', or { skill: name } when `p` lies in a skill's own directory under a skill root: the nearest
// directory holding a SKILL.md, so a same-named folder elsewhere under the root does not count. `p` comes
// from realPath.
export function readPlace(p, wl) {
  if (wl.roots.some((r) => within(p, r))) return 'in';
  const mr = (wl.memoryRoots || []).find((r) => within(p, r));
  if (mr && p.slice(mr.length).split('/').filter(Boolean)[1] === 'memory') return 'in';
  const sr = wl.session && wl.sessionRoots.find((r) => within(p, r));
  if (sr && p.slice(sr.length).split('/').includes(wl.session)) return 'in';
  const root = wl.skillRoots.find((r) => within(p, r));
  if (!root) return 'out';
  const segs = p.slice(root.length).split('/').filter(Boolean);
  for (let i = segs.length; i > 0; i -= 1) {
    if (fs.existsSync(`${root}/${segs.slice(0, i).join('/')}/SKILL.md`)) return { skill: segs[i - 1] };
  }
  return 'out';
}
// The user named the path, or a directory above it, in the current request.
// Paths in the prompt resolve the same way, so a short or linked spelling still matches. A drive root, the
// home directory or anything above it is too broad to count as naming a place: home holds the credentials.
const PROMPT_PATH = /(?:[a-z]:[\\/]|~[\\/])[^\s"'`<>|，。；、：）),;]*/gi;
export function namedInPrompt(promptText, p, home = os.homedir()) {
  const h = realPath(home);
  const usable = (r) => r.split('/').filter(Boolean).length >= 2 && !within(h, r);
  for (const m of String(promptText || '').matchAll(PROMPT_PATH)) {
    const full = m[0].replace(/^~(?=[\\/])/, home).replace(/[\\/.]+$/, '');
    // A CJK prompt often has no space after a path ("C:\notes里的文件"). Only when the full text is not a real path, try
    // it without the trailing CJK run (never shortening a real path to its parent).
    const short = full.replace(/[\u3400-\u9fff]+$/u, '');
    const raw = fs.existsSync(full) || short === full ? full : short;
    const r = realPath(raw);
    if (usable(r) && within(p, r)) return true;
  }
  return false;
}
// Absolute paths a shell command reads, listing included. Rough on purpose: the result is only logged.
const SHELL_READ_VERB = /(^|[\s;&|(])(ls|dir|find|fd|tree|wc|stat|du|get-childitem|gci|test-path|resolve-path|cd|set-location|pushd)(\s|$)/i;
const HOME_VAR = /^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i;
export function shellReadPaths(command) {
  const body = stripLiteralBodies(command);
  if (!SENSITIVE_READ_VERB.test(body) && !SHELL_READ_VERB.test(body)) return [];
  const out = new Set();
  // Quoted arguments stay whole ("C:/My Docs/a.txt"); the rest splits on shell punctuation.
  for (const m of body.matchAll(/"([^"]+)"|'([^']+)'|([^\s"'`;|&<>()=,]+)/g)) {
    let t = m[1] ?? m[2] ?? m[3];
    if (!t) continue;
    t = t.replace(HOME_VAR, '~');
    if (/[$%{}]/.test(t)) continue; // other variables: nothing literal to judge
    if (!/^(?:[a-z]:[\\/]|\/[a-z](?:\/|$)|~(?:[\\/]|$))/i.test(t)) continue;
    const literal = t.split(/[*?[]/)[0];
    out.add(/[*?[]/.test(t) ? literal.replace(/[\\/][^\\/]*$/, '') || literal : literal);
  }
  return [...out];
}

// Returns { status, triggered: [rule], missing: [{ rule, why }], memoryWrites, window }.
// Only the last `readWindowPrompts` user prompts count, for triggers and reads alike, so a rule read for
// an earlier task does not cover a new one.
export function ruleCoverage({ transcriptPath, cwd, scratchpadDir, lastMessage, cfg, home = os.homedir() }) {
  if (!cfg || !cfg.ruleCoverage) return { status: 'disabled' };
  if (!transcriptPath) return { status: 'no_transcript' };
  const ctx = coverageContext({ cwd, scratchpadDir, cfg, home });
  const tx = readToolCalls(transcriptPath, ctx.rc.maxTranscriptBytes || 20 * 1024 * 1024, ctx.rc.tailTranscriptBytes);
  if (tx.status !== 'ok') return { status: tx.status };
  const size = ctx.rc.readWindowPrompts || 5;
  const from = Math.max(0, tx.prompts - size + 1);
  const calls = tx.calls.filter((c) => c.prompt >= from);

  const triggered = new Map();
  let memoryWrites = 0;
  for (const c of calls) {
    for (const t of classifyCall(c, ctx)) {
      if (t.memory) memoryWrites += 1;
      else if (!triggered.has(t.rule)) triggered.set(t.rule, t.why);
    }
  }
  if (hasCompletionClaim(lastMessage)) triggered.set('rules/completion-claims.md', 'completion claim');
  // Any tool use beyond reading rules makes INDEX.md the first stop (core.md "Loading rules").
  if (calls.some((c) => !isRuleRead(c, ctx.inLibrary))) triggered.set(INDEX_RULE, 'a task that uses tools');

  // Must-use rules ship inside the entry file (core.md "Loading rules"), so they are never "missing".
  const missing = [...triggered]
    .filter(([rule]) => !isMustRule(cfg, rule))
    .filter(([rule]) => !calls.some((c) => readsRule(c, rule.split('/').pop(), ctx.inLibrary)))
    .map(([rule, why]) => ({ rule, why }));
  return { status: 'checked', triggered: [...triggered.keys()], missing, memoryWrites, window: { from, prompts: tx.prompts } };
}

// ---------- enforcement settings ----------
// hooks.enforce.<key> is "off", "warn" or "enforce"; a missing key means "warn" (old behaviour).
export function enforceLevel(cfg, key) {
  const v = cfg && cfg.enforce && cfg.enforce[key];
  return v === 'off' || v === 'enforce' ? v : 'warn';
}
// Must-use rules (hooks.mustRules) are shipped inside the entry file, so they never need a read.
export function isMustRule(cfg, rule) {
  const list = (cfg && cfg.mustRules) || [];
  return list.some((r) => r === rule || r.split('/').pop() === String(rule).split('/').pop());
}

// ---------- source labels (rules/research.md, rules/source-grading.md) ----------
// Every cited external source carries an effective grade letter (S/A/B/C/D/×) and a read mode;
// freshness is written when the date is known and access dates are no longer used. A grade written
// on the heading a list sits under ("**Grade S** · official sources") counts for every line below it.
// Lists should run from the highest grade to the lowest; that part is reported, not enforced.
const SOURCE_GRADE = /(?:^|[\s—–\-:：|（(*])(?:Grade\s+)?([SABCD×])(?=\s*(?:[·|｜,，)）*]|级))/;
const SOURCE_MODE = /opened|page summary|search snippet|snippet|republished|打开原页|已核对原页|原页|页面摘要|搜索摘要|转载/i;
const URL_RE = /https?:\/\/[^\s)>\]]+/;
const RANK = { S: 0, A: 1, B: 2, C: 3, D: 4, '×': 5 };

export function sourceLabelGaps(msg) {
  const text = (typeof msg === 'string' ? msg : '').replace(/^```[\s\S]*?^```/gm, '');
  let heading = '';
  let sources = 0;
  let unlabeled = 0;
  const ranks = [];
  for (const line of text.split('\n')) {
    if (!URL_RE.test(line)) {
      if (line.trim()) heading = line;
      continue;
    }
    sources += 1;
    // The grade sits after the link ("](URL) — A ·"), so a letter inside the link title does not count.
    const after = line.slice(line.search(URL_RE));
    const grade = after.match(SOURCE_GRADE) || heading.match(SOURCE_GRADE);
    if (grade) ranks.push(RANK[grade[1].toUpperCase()] ?? RANK[grade[1]]);
    if (!(grade && SOURCE_MODE.test(`${heading} ${line}`))) unlabeled += 1;
  }
  const unsorted = ranks.some((r, i) => i > 0 && r < ranks[i - 1]);
  return { sources, unlabeled, flagged: sources >= 2 && unlabeled > 0, unsorted };
}

// True when a search tool ran after the most recent user prompt.
export function searchedThisTurn(transcriptPath, cfg) {
  const rc = (cfg && cfg.ruleCoverage) || {};
  const tools = rc.searchTools || [];
  if (!transcriptPath || !tools.length) return false;
  const tx = readToolCalls(transcriptPath, rc.maxTranscriptBytes || 20 * 1024 * 1024, rc.tailTranscriptBytes);
  return tx.status === 'ok' && tx.calls.some((c) => c.prompt === tx.prompts && tools.includes(c.name));
}

// Files a call writes: Write/Edit targets, shell redirects, and scripts in a heredoc that write a quoted
// source path (`python - <<'EOF' … open(p,'w')`), which is how many edits in long sessions were made.
const SCRIPT_WRITE = /open\([^)]*['"][wa]|write_text|\.write\(|writeFileSync|Set-Content|Out-File/;
const QUOTED_SOURCE = /['"]([\w./\\-]+\.(?:[cm]?[jt]sx?|css|scss|astro|vue|svelte|py|json|html?|toml|ya?ml|md))['"]/g;
function changeTargets(c, cwd, rc) {
  if ((rc.writeTools || []).includes(c.name)) return typeof c.input.file_path === 'string' ? [norm(c.input.file_path)] : [];
  if (!(rc.shellTools || []).includes(c.name) || typeof c.input.command !== 'string') return [];
  const cmd = c.input.command;
  const out = shellWriteTargets(cmd, cwd);
  if (/<<-?\s*['"]?\w+/.test(cmd) && SCRIPT_WRITE.test(cmd)) {
    const cd = cmd.match(new RegExp(String.raw`^\s*(?:cd|set-location|pushd)\s+` + PATH_ARG, 'i'));
    const base = cd ? (cd[1] || cd[2] || cd[3]) : cwd;
    for (const m of cmd.matchAll(QUOTED_SOURCE)) out.push(resolveShellPath(m[1], base));
  }
  return out;
}
// Changes that can invalidate a check: not the scratchpad or a project's `.codex-temp/` (the project-local temp
// directory, core.md "Where files go"), memory, plans, the update log or the changelog.
// Prose files outside the rule library are skipped too (nothing there is usually under test).
export const PROJECT_TEMP = /(^|\/)\.codex-temp\//;
function projectChange(p, ctx, cfg) {
  if (ctx.scratch && within(p, ctx.scratch)) return false;
  if (PROJECT_TEMP.test(p)) return false;
  if (ctx.memoryPath && ctx.memoryPath.test(p)) return false;
  if (/\/\.claude\/plans\//.test(p) || /(^|\/)changelog\.md$/.test(p)) return false;
  if (p.includes(`/${norm(cfg.defaultLogDir || 'update logs')}/`)) return false;
  return ctx.inLibrary || !/\.(md|txt)$/.test(p);
}

// Stale green: in the current prompt, each kind of check (`node --test`, `npm run build`, a QA script)
// is judged on its own last run, so a later unit-test run cannot hide an older browser QA run that went
// stale. Heredoc bodies are text (a log entry that mentions `npm run build` is not a check).
export function staleVerification({ transcriptPath, cwd, scratchpadDir, cfg, home = os.homedir() }) {
  const ctx = coverageContext({ cwd, scratchpadDir, cfg, home });
  const rc = ctx.rc;
  if (!rc.verifyCommandPattern) return { status: 'disabled' };
  if (!transcriptPath) return { status: 'no_transcript' };
  // Stop runs once per prompt and needs the whole prompt, so it may read a larger tail than the gate.
  const tx = readToolCalls(transcriptPath, rc.maxTranscriptBytes || 20 * 1024 * 1024, rc.stopTailTranscriptBytes || rc.tailTranscriptBytes);
  if (tx.status !== 'ok') return { status: tx.status };
  const verify = new RegExp(rc.verifyCommandPattern, 'gi');
  const turn = tx.calls.filter((c) => c.prompt === tx.prompts);
  const lastRun = new Map(); // check kind -> index of its last run in this prompt
  // A runner subagent asked to run a check counts as running it (rules/delegation.md: its transcript is the
  // evidence); an implementer subagent edits files in its own transcript, so it counts as a change.
  const subagent = (c, type) => (c.name === 'Agent' || c.name === 'Task') && c.input && c.input.subagent_type === type;
  turn.forEach((c, i) => {
    const command = (rc.shellTools || []).includes(c.name) && typeof c.input.command === 'string' ? stripInlineScripts(stripLiteralBodies(c.input.command))
      : subagent(c, 'runner') && typeof c.input.prompt === 'string' ? c.input.prompt : null;
    if (command === null) return;
    for (const m of command.matchAll(verify)) lastRun.set(m[0].toLowerCase().replace(/\s+/g, ' '), i);
  });
  if (!lastRun.size) return { status: 'no_check' };
  const writes = turn.map((c) => (subagent(c, 'implementer') ? ['(changes made by the implementer subagent)']
    : changeTargets(c, cwd, rc).filter((p) => projectChange(p, ctx, cfg))));
  const staleChecks = [];
  for (const [check, i] of lastRun) {
    const changed = [...new Set(writes.slice(i + 1).flat())];
    if (changed.length) staleChecks.push({ check, changed });
  }
  return { status: 'checked', checks: lastRun.size, stale: staleChecks, changed: [...new Set(staleChecks.flatMap((s) => s.changed))] };
}

// Lines written to project files in the recent prompts, and whether a fresh-context review followed.
const REVIEW_CALL = /review|\bdiff\b|审查|审阅/i;
export function unreviewedChange({ transcriptPath, cwd, scratchpadDir, cfg, home = os.homedir() }) {
  const ctx = coverageContext({ cwd, scratchpadDir, cfg, home });
  const rc = ctx.rc;
  if (!transcriptPath) return { status: 'no_transcript' };
  const tx = readToolCalls(transcriptPath, rc.maxTranscriptBytes || 20 * 1024 * 1024, rc.tailTranscriptBytes);
  if (tx.status !== 'ok') return { status: tx.status };
  const size = rc.readWindowPrompts || 5;
  const calls = tx.calls.filter((c) => c.prompt >= Math.max(0, tx.prompts - size + 1));
  let lines = 0; let lastWrite = -1;
  calls.forEach((c, i) => {
    if (!(rc.writeTools || []).includes(c.name) || typeof c.input.file_path !== 'string' || !projectChange(norm(c.input.file_path), ctx, cfg)) return;
    const body = [c.input.content, c.input.new_string, ...(Array.isArray(c.input.edits) ? c.input.edits.map((e) => e && e.new_string) : [])].filter((x) => typeof x === 'string');
    lines += body.reduce((n, s) => n + s.split('\n').length, 0);
    lastWrite = i;
  });
  const reviewed = calls.slice(lastWrite + 1).some((c) => ((c.name === 'Agent' || c.name === 'Task') && REVIEW_CALL.test(JSON.stringify(c.input)))
    || (c.name === 'Skill' && /code-review|security-review/.test(String(c.input.skill || ''))));
  return { status: 'checked', lines, reviewed, prompts: tx.prompts };
}

// True when the call only reads a file of the rule library (rules, INDEX) or searches tools.
export function isRuleRead(c, inLibrary) {
  if (c.name === 'ToolSearch') return true;
  const input = c.input || {};
  const text = norm(input.file_path || input.command || '');
  return (c.name === 'Read' || READ_VERB.test(text)) && (inLibraryPath(text) || inLibrary);
}

// Only read-shaped calls count: the Read tool on the rule file, or a shell command with a read verb
// that names the file under the rule library (covers `cd <library>/rules && cat x.md`).
// Writes, edits and commands that merely mention a rule name (tests, grep, scripts) do not count.
const READ_VERB = /(^|[\s;&|(])(cat|type|get-content|gc|sed|head|tail|less|more|nl|awk|bat)(\s|$)/;
export function readsRule(call, base, inLibrary = false) {
  const input = (call && call.input) || {};
  const b = base.toLowerCase();
  if (call.name === 'Read') {
    const p = norm(input.file_path || '');
    return p.endsWith('/' + b) && (inLibraryPath(p) || inLibrary);
  }
  const cmd = typeof input.command === 'string' ? norm(input.command) : null;
  if (!cmd || !READ_VERB.test(cmd) || !(inLibraryPath(cmd) || inLibrary)) return false;
  const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[/\\s"'])${esc}(?![a-z0-9._-])`).test(cmd);
}

// ---------- git baseline and change counting ----------

const SENSITIVE = /(^|\/)(\.env(\..*)?|.*secret.*|.*\.pem|.*\.key|id_[a-z0-9]+|.*credentials.*|auth\.json|\.npmrc|\.pypirc|.*cookies?.*)$/i;
const EXCLUDED = /(^|\/)(node_modules|vendor|third_party|dist|build|out|coverage|\.next|docs)\/|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|[^/]+\.lock)$|\.(md|markdown|txt|min\.js|map|snap)$/i;
const LOG_DIR = /(^|\/)(update[ _-]?logs?|更新日志)(\/|$)/i; // 更新日志 = "update log", kept as an alias

export function isCounted(rel) {
  return !EXCLUDED.test(rel) && !LOG_DIR.test(rel);
}

function git(cwd, args, timeout) {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false',
    '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', ...args],
  { timeout, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
const zlist = (buf) => buf.toString('utf8').split('\0').filter(Boolean);

export function repoKey(top) {
  return crypto.createHash('sha256').update(top.toLowerCase()).digest('hex').slice(0, 16);
}

function baselinePath(sessionId, top, dir) {
  const sid = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, 'sessions', sid, repoKey(top));
}

export function toplevel(cwd, timeout = 3000) {
  try { return git(cwd, ['rev-parse', '--show-toplevel'], timeout).toString('utf8').trim(); } catch { return null; }
}

export function recordBaseline({ sessionId, cwd, cfg, dir = stateDir(), now = Date.now() }) {
  const top = toplevel(cwd);
  if (!top) return { status: 'not_git' };
  const base = baselinePath(sessionId, top, dir);
  if (fs.existsSync(path.join(base, 'baseline.json'))) return { status: 'exists', top };
  const t = cfg.budgetMs;
  let head = null;
  try { head = git(top, ['rev-parse', 'HEAD'], t).toString().trim(); } catch { /* unborn branch */ }
  const dirty = head ? zlist(git(top, ['diff', '--name-only', '-z', head], t)) : [];
  const untracked = zlist(git(top, ['ls-files', '-o', '--exclude-standard', '-z'], t));
  const record = { top, head, started_at: now, dirty: [], untracked: [], skipped: null };
  if (dirty.length + untracked.length > cfg.maxDirtyFiles) {
    record.skipped = `too_many_dirty_files:${dirty.length + untracked.length}`;
  } else {
    for (const [list, key] of [[dirty, 'dirty'], [untracked, 'untracked']]) {
      for (const rel of list) {
        if (!isCounted(rel)) continue;
        if (SENSITIVE.test(rel)) { record[key].push({ rel, snapshot: false }); continue; }
        const abs = path.join(top, rel);
        let snap = false;
        try {
          const st = fs.statSync(abs);
          if (st.isFile() && st.size <= 2 * 1024 * 1024) {
            const dest = path.join(base, 'snap', rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(abs, dest);
            snap = true;
          }
        } catch { /* deleted or unreadable */ }
        record[key].push({ rel, snapshot: snap });
      }
    }
  }
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'baseline.json'), JSON.stringify(record, null, 2));
  return { status: 'recorded', top, skipped: record.skipped };
}

function numstatSum(buf) {
  let n = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    const m = line.match(/^(\d+)\t(\d+)\t/);
    if (m) n += Number(m[1]) + Number(m[2]);
  }
  return n;
}

function countLines(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return 0; // binary
    const s = buf.toString('utf8');
    return s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;
  } catch { return 0; }
}

function noIndexNumstat(a, b, t) {
  try {
    execFileSync('git', ['diff', '--no-index', '--numstat', a, b], { timeout: t, stdio: ['ignore', 'pipe', 'ignore'] });
    return 0;
  } catch (err) {
    return err.stdout ? numstatSum(err.stdout) : 0; // exit code 1 means "differences found"
  }
}

// Returns { status, changed, logged } for the repo containing cwd.
export function measure({ sessionId, cwd, cfg, dir = stateDir() }) {
  const top = toplevel(cwd);
  if (!top) return { status: 'not_git' };
  const base = baselinePath(sessionId, top, dir);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(base, 'baseline.json'), 'utf8')); } catch { return { status: 'no_baseline', top }; }
  if (rec.skipped) return { status: 'skipped', reason: rec.skipped, top };
  const t = cfg.budgetMs;
  const known = new Map([...rec.dirty, ...rec.untracked].map((e) => [e.rel, e]));
  let changed = 0;
  let unknown = false;

  // Tracked files that were clean at start: compare with the baseline commit.
  if (rec.head) {
    const out = git(top, ['diff', '--numstat', '--no-renames', rec.head], t).toString('utf8');
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+)\t(\d+)\t(.+)$/);
      if (m && isCounted(m[3]) && !known.has(m[3])) changed += Number(m[1]) + Number(m[2]);
    }
  }
  // Files that were dirty or untracked at start: compare with their snapshot.
  for (const e of known.values()) {
    const cur = path.join(top, e.rel);
    if (!e.snapshot) { unknown = true; continue; }
    const snap = path.join(base, 'snap', e.rel);
    if (!fs.existsSync(cur)) { changed += countLines(snap); continue; }
    changed += noIndexNumstat(snap, cur, t);
  }
  // New untracked files created during the session.
  for (const rel of zlist(git(top, ['ls-files', '-o', '--exclude-standard', '-z'], t))) {
    if (!known.has(rel) && isCounted(rel)) changed += countLines(path.join(top, rel));
  }
  return { status: 'measured', top, changed, unknown, logged: logTouchedSince(top, rec.started_at, cfg) };
}

export function logTouchedSince(top, since, cfg) {
  const roots = [path.join(top, cfg.defaultLogDir)];
  try {
    for (const e of fs.readdirSync(top, { withFileTypes: true })) {
      if (e.isDirectory() && LOG_DIR.test(e.name + '/')) roots.push(path.join(top, e.name));
      if (e.isDirectory() && e.name === 'docs') {
        for (const d of fs.readdirSync(path.join(top, 'docs'), { withFileTypes: true })) {
          if (d.isDirectory() && LOG_DIR.test(d.name + '/')) roots.push(path.join(top, 'docs', d.name));
        }
      }
    }
  } catch { /* ignore */ }
  const stack = [...new Set(roots)];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { if (fs.statSync(p).mtimeMs >= since) return true; } catch { /* ignore */ } }
    }
  }
  return false;
}
