#!/usr/bin/env node
// PostToolUse hook (Claude Code only), registered for every tool. After any tool call that is not itself
// a rule read, remind the model once if INDEX.md has not been read in the recent prompts; after a search,
// browser, MCP, config or shell-write call, also name the on-demand rule that call required.
// Advisory: returns additionalContext, never blocks. One nudge per rule per block of prompts.
// Usage: node rule-nudge.mjs --host claude   (JSON on stdin)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readStdinJson, hooksDisabled, loadHookConfig, appendLog, stateDir,
  coverageContext, classifyCall, readToolCalls, readsRule, isRuleRead, INDEX_RULE, isMustRule,
} from './lib.mjs';

const host = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'unknown';

export function run(input, { cfg = loadHookConfig(), dir = stateDir(), host: h = host } = {}) {
  if (hooksDisabled()) return null;
  const rc = cfg.ruleCoverage;
  if (!rc || !(rc.hosts || []).includes(h)) return null;
  if (input.agent_id || input.agent_type) return null;
  const name = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!name || (rc.nudgeSkipTools && new RegExp(rc.nudgeSkipTools).test(name))) return null;

  const ctx = coverageContext({ cwd: input.cwd, scratchpadDir: input.scratchpad_dir, cfg });
  const call = { name, input: input.tool_input || {} };
  // A call that reads the rule library is the fix, not the problem (and the transcript may not show it yet).
  if (isRuleRead(call, ctx.inLibrary)) return null;
  // Must-use rules (and INDEX.md) ship inside the entry file, so only scene rules are worth a nudge.
  const needed = classifyCall(call, ctx).filter((t) => !t.memory && !isMustRule(cfg, t.rule));

  // Reads come from the transcript; the call that fired this hook is passed on stdin, not read back.
  const tx = input.transcript_path ? readToolCalls(input.transcript_path, rc.maxTranscriptBytes || 20 * 1024 * 1024, rc.tailTranscriptBytes) : { status: 'no_transcript' };
  const size = rc.readWindowPrompts || 5;
  const calls = tx.status === 'ok' ? tx.calls.filter((c) => c.prompt >= Math.max(0, tx.prompts - size + 1)) : [];
  const bucket = tx.status === 'ok' ? Math.floor(tx.prompts / size) : 0;
  const read = (rule) => calls.some((c) => readsRule(c, rule.split('/').pop(), ctx.inLibrary));
  const rules = [...new Map(needed.map((t) => [t.rule, t])).values()];
  if (!isMustRule(cfg, INDEX_RULE) && !read(INDEX_RULE)) rules.unshift({ rule: INDEX_RULE, why: name });
  const fresh = rules.filter((t) => !read(t.rule) && !nudged(input.session_id, `${t.rule}@${bucket}`, dir));

  appendLog({ host: h, event: 'PostToolUse', session: input.session_id, tool: name, transcript: tx.status, nudged: fresh.map((t) => t.rule) }, dir);
  if (!fresh.length) return null;
  for (const t of fresh) markNudged(input.session_id, `${t.rule}@${bucket}`, dir);
  const list = fresh.map((t) => t.rule).join(', ');
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: needed.length
        ? `[rules-as-code: nudge] The ${name} call just made needs scene rules that were not read in the recent prompts: ${list}. Read them before going on and adjust the next steps to them.`
        : `[rules-as-code: nudge] This task is already using tools (${name}), but ${list} was not read in the recent prompts. Per core.md "Loading rules", read it before going on and pick up the scene rules its routing table points to; ignore this if you just read it.`,
    },
  };
}

function flag(sessionId, key, dir) {
  const sid = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, 'sessions', sid, 'rule-nudged', key.replace(/[^A-Za-z0-9_.@-]/g, '_'));
}
function nudged(sessionId, key, dir) { return fs.existsSync(flag(sessionId, key, dir)); }
function markNudged(sessionId, key, dir) {
  try { const f = flag(sessionId, key, dir); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString()); } catch { /* ignore */ }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = loadHookConfig();
  const killer = setTimeout(() => process.exit(0), cfg.budgetMs + 3000);
  try {
    const out = run(await readStdinJson(), { cfg });
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    appendLog({ host, event: 'PostToolUse', error: String(err && err.message || err).slice(0, 300) });
  }
  clearTimeout(killer);
  process.exit(0);
}
