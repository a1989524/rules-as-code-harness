#!/usr/bin/env node
// Stop hook shared by Claude Code and Codex.
// Checks the fixed closing sections and the 700-line update-log trigger, and (Claude only) the source
// labels after a web search, whether the scene rules the session's tool calls required were read, pass
// claims made after files changed since the last check, and large changes claimed done without a
// fresh-context review. Each check blocks the stop when its hooks.enforce switch is "enforce";
// stop_hook_active (the model is already continuing because of a block) always passes, so a block
// happens at most once per stop. Everything else stays advisory.
// Usage: node closing-check.mjs --host claude|codex   (JSON on stdin)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readStdinJson, hooksDisabled, loadHookConfig, appendLog, stateDir,
  isMachineOutput, checkTail, measure, repoKey, waitingOnBackground, looksLikeProgressUpdate, ruleCoverage,
  sourceLabelGaps, searchedThisTurn, enforceLevel, turnDelegation, MODEL_TIER_LINE, claimsPassing, hasCompletionClaim, staleVerification, unreviewedChange,
  readToolCalls, classifyPrompt, tierOf, countQuestions,
} from './lib.mjs';

const host = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'unknown';

export async function run(input, { cfg = loadHookConfig(), dir = stateDir(), host: h = host } = {}) {
  if (hooksDisabled()) return null;
  if (input.stop_hook_active) return null;
  if (input.permission_mode === 'plan') return null;
  if (input.agent_id || input.agent_type || input.parent_session_id || input.is_subagent) return null;

  const issues = [];
  const blockers = [];
  const msg = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  // Progress updates while delegated work is in flight are exempt from the closing sections.
  let tailSkip = null;
  try {
    if (waitingOnBackground(input)) tailSkip = 'background_tasks';
    else if (looksLikeProgressUpdate(msg)) tailSkip = 'progress_phrasing';
  } catch { tailSkip = null; } // fail open: an unexpected shape just means "check as usual"
  if (msg.trim() && !isMachineOutput(msg) && !tailSkip && enforceLevel(cfg, 'stopClosing') !== 'off') {
    const tail = checkTail(msg);
    if (tail) (enforceLevel(cfg, 'stopClosing') === 'enforce' ? blockers : issues).push(tail);
  }

  // Rule coverage is advisory in every mode: it never blocks, even when hooks.mode is "block".
  const advisory = [];
  let cov = null;
  const rc = cfg.ruleCoverage;
  if (rc && (rc.hosts || []).includes(h)) {
    try {
      cov = ruleCoverage({ transcriptPath: input.transcript_path, cwd: input.cwd, scratchpadDir: input.scratchpad_dir, lastMessage: msg, cfg });
    } catch (err) { cov = { status: 'error', error: String(err.message || err).slice(0, 200) }; }
    // One reminder per rule per block of `readWindowPrompts` user prompts, so a later task can be reminded again.
    const bucket = cov && cov.window ? Math.floor(cov.window.prompts / (rc.readWindowPrompts || 5)) : 0;
    const key = (rule) => `${rule}@${bucket}`;
    const fresh = cov && cov.missing ? cov.missing.filter((x) => !ruleNotified(input.session_id, key(x.rule), dir)) : [];
    if (fresh.length) {
      const pairs = fresh.map((x) => `${x.why} → ${x.rule}`).join('; ');
      advisory.push(`Recent prompts used actions that need scene rules, but the transcript shows no read of them: ${pairs}. Read them per core.md "Loading rules" and INDEX.md, and say in the closing how this affects the result. The transcript can lag behind this turn's latest calls; ignore rules you just read.`);
      for (const x of fresh) markRuleNotified(input.session_id, key(x.rule), dir);
    }
    if (cov && cov.memoryWrites && !ruleNotified(input.session_id, `memory-consent@${bucket}`, dir)) {
      advisory.push('Recent prompts wrote to long-term memory. Under core.md "Permissions and writes", say what will be remembered and get consent before storing anything about the user; if you have not asked, say what was written and ask whether to keep it.');
      markRuleNotified(input.session_id, `memory-consent@${bucket}`, dir);
    }
  } else if (rc) {
    cov = { status: 'unsupported_host' };
  }

  // Source labels: after a web search this turn, cited sources carry an effective grade and a read mode,
  // sorted from the highest grade down (rules/source-grading.md).
  let labels = null;
  if (rc && (rc.hosts || []).includes(h) && msg.trim() && !tailSkip && enforceLevel(cfg, 'stopSourceLabels') !== 'off') {
    try {
      const gaps = sourceLabelGaps(msg);
      if (gaps.sources >= 2 && searchedThisTurn(input.transcript_path, cfg)) {
        labels = gaps;
        if (gaps.flagged) {
          const text = `This turn used web search, and ${gaps.unlabeled} of the ${gaps.sources} sources in the answer carry no effective grade and read mode. Per rules/source-grading.md, write each as "- [Title](URL) — A · source type · freshness · read mode", sorted from the highest grade down, with no access date; a source list the host asks for uses the same format.`;
          (enforceLevel(cfg, 'stopSourceLabels') === 'enforce' ? blockers : advisory).push(text);
        } else if (gaps.unsorted) {
          advisory.push('The source list is not sorted by effective grade (S, A, B, C, D, ×); sort it next time per rules/source-grading.md.');
        }
      }
    } catch { labels = null; } // fail open
  }

  // Stale green (rules/completion-claims.md): the answer says checks passed, but project files changed
  // after the last check of this prompt.
  const claude = rc && (rc.hosts || []).includes(h) && msg.trim() && !tailSkip;
  const where = { transcriptPath: input.transcript_path, cwd: input.cwd, scratchpadDir: input.scratchpad_dir, cfg };
  let stale = null;
  if (claude && enforceLevel(cfg, 'stopStaleVerification') !== 'off' && claimsPassing(msg)) {
    try {
      stale = staleVerification(where);
      if (stale.stale && stale.stale.length) {
        const short = (p) => p.split('/').slice(-2).join('/');
        const each = stale.stale.slice(0, 4).map((s) => `${s.check} (${s.changed.length} file(s) changed after it: ${s.changed.slice(0, 3).map(short).join(', ')}${s.changed.length > 3 ? ', …' : ''})`).join('; ');
        const text = `The answer says checks passed, but files changed after the last run of these checks in this turn: ${each}. Per rules/completion-claims.md, re-run the affected checks or say "passed before the last change, not re-run".`;
        (enforceLevel(cfg, 'stopStaleVerification') === 'enforce' ? blockers : advisory).push(text);
      }
    } catch { stale = null; } // fail open
  }

  // Independent review (rules/completion-claims.md): a large change claimed done without a review of the
  // diff in a fresh context. Reminded once per block of `readWindowPrompts` user prompts.
  let review = null;
  if (claude && enforceLevel(cfg, 'stopIndependentReview') !== 'off' && hasCompletionClaim(msg)) {
    try {
      review = unreviewedChange(where);
      const limit = rc.reviewLinesThreshold || 500;
      const key = `review@${Math.floor((review.prompts || 0) / (rc.readWindowPrompts || 5))}`;
      if (review.status === 'checked' && review.lines >= limit && !review.reviewed && !ruleNotified(input.session_id, key, dir)) {
        const text = `Recent prompts wrote about ${review.lines} lines to project files, and no fresh-context review of the diff followed. Per rules/completion-claims.md, a change of ${limit}+ lines or 3+ modules gets a subagent review of this diff alone before it is called done; each finding gets a failing test before the fix.`;
        (enforceLevel(cfg, 'stopIndependentReview') === 'enforce' ? blockers : advisory).push(text);
        markRuleNotified(input.session_id, key, dir);
      }
    } catch { review = null; } // fail open
  }

  // Requirement analysis (rules/requirement-analysis.md), observation period: log the tier line, how many
  // questions the answer asked and what kind of prompt it answered. Never blocks.
  let analysis = null;
  if (claude && enforceLevel(cfg, 'analysisLog') !== 'off') {
    try {
      const tx = input.transcript_path ? readToolCalls(input.transcript_path, rc.maxTranscriptBytes || 20 * 1024 * 1024, rc.tailTranscriptBytes) : null;
      const ok = tx && tx.status === 'ok' && !(tx.truncated && !tx.prompts); // a tail with no prompt can't tell the kind
      const kind = ok ? classifyPrompt(tx.promptText, cfg).kind : undefined;
      // The tier line usually opens the turn, not the final message.
      const earlier = ok ? (tx.tiers || []).filter((t) => t.prompt === tx.prompts).pop() : null;
      analysis = { tier: tierOf(msg) || (earlier ? earlier.tier : null), questions: countQuestions(msg), kind };
    } catch { analysis = null; } // fail open
  }

  // Delegation (rules/delegation.md), observation only: subagents started this turn by role, and whether the
  // answer has the "Delegation:" line. Never blocks or reminds.
  let delegation = null;
  if (input.transcript_path) {
    const lim = rc || {};
    try {
      delegation = turnDelegation(input.transcript_path, h, msg, { maxBytes: lim.maxTranscriptBytes || 20 * 1024 * 1024,
        tailBytes: lim.stopTailTranscriptBytes || lim.tailTranscriptBytes || 2 * 1024 * 1024 });
      // A stop while subagents or workflows still run is a progress message, not the answer that owes the line.
      delegation.final = !tailSkip;
    } catch { delegation = null; } // fail open
  }

  let m = null;
  if (input.cwd) {
    try { m = measure({ sessionId: input.session_id, cwd: input.cwd, cfg, dir }); } catch (err) { m = { status: 'error', error: String(err.message || err).slice(0, 200) }; }
  }
  if (m && m.status === 'measured' && m.changed >= cfg.changedLinesThreshold && !m.logged && !alreadyNotified(input.session_id, m.top, dir)) {
    issues.push(`This session changed about ${m.changed} counted lines in ${m.top}, at or over the ${cfg.changedLinesThreshold}-line threshold, and no project update log was touched. Decide and record it per rules/update-logs.md.`);
    markNotified(input.session_id, m.top, dir);
  }

  appendLog({ host: h, event: 'Stop', session: input.session_id, mode: cfg.mode, issues, advisory, blocked: blockers.length > 0, ...(tailSkip && { tail_skipped: tailSkip }),
    ...(labels && { source_labels: { sources: labels.sources, unlabeled: labels.unlabeled, unsorted: labels.unsorted } }),
    ...(stale && { stale: { status: stale.status, checks: stale.checks, stale: stale.stale && stale.stale.map((s) => s.check), changed: stale.changed ? stale.changed.length : undefined } }),
    ...(review && { review: { status: review.status, lines: review.lines, reviewed: review.reviewed } }),
    ...(analysis && { analysis }),
    ...(delegation && { delegation }),
    ...(msg.trim() && !tailSkip && { tierLine: MODEL_TIER_LINE.test(msg) }),
    measure: m && { status: m.status, changed: m.changed, logged: m.logged, unknown: m.unknown },
    coverage: cov && { status: cov.status, triggered: cov.triggered, missing: cov.missing && cov.missing.map((x) => x.rule), memoryWrites: cov.memoryWrites } }, dir);
  if (blockers.length) return { decision: 'block', reason: `[rules-as-code: check] ${[...blockers, ...issues, ...advisory].join(' ')}` };
  if (!issues.length && !advisory.length) return null;
  if (cfg.mode === 'block' && issues.length) return { decision: 'block', reason: `[rules-as-code: check] ${[...issues, ...advisory].join(' ')}` };
  if (h === 'claude') return { systemMessage: `[rules-as-code: reminder only] ${[...issues, ...advisory].join(' ')}` };
  return null; // Codex warn mode: log only
}

function ruleFlag(sessionId, rule, dir) {
  const sid = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, 'sessions', sid, 'rule-notified', rule.replace(/[^A-Za-z0-9_.-]/g, '_'));
}
function ruleNotified(sessionId, rule, dir) { return fs.existsSync(ruleFlag(sessionId, rule, dir)); }
function markRuleNotified(sessionId, rule, dir) {
  try { const f = ruleFlag(sessionId, rule, dir); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString()); } catch { /* ignore */ }
}

function flagFile(sessionId, top, dir) {
  const sid = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, 'sessions', sid, repoKey(top), 'log-notified');
}
function alreadyNotified(sessionId, top, dir) { return fs.existsSync(flagFile(sessionId, top, dir)); }
function markNotified(sessionId, top, dir) {
  try { const f = flagFile(sessionId, top, dir); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString()); } catch { /* ignore */ }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = loadHookConfig();
  const killer = setTimeout(() => process.exit(0), cfg.budgetMs + 3000);
  try {
    const out = await run(await readStdinJson(), { cfg });
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    appendLog({ host, event: 'Stop', error: String(err && err.message || err).slice(0, 300) });
  }
  clearTimeout(killer);
  process.exit(0);
}
