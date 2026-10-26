#!/usr/bin/env node
// UserPromptSubmit hook shared by Claude Code and Codex. Adds a short note (<= 600 chars) to every prompt:
//   - today's local date, so "latest" questions are judged against the real present, not training memory;
//   - for fast-moving topics (hooks.fastDomainKeywords): anchor the current version before trusting sources;
//   - for new projects, features or plans (hooks.reusePromptKeywords): do the reuse search first;
//   - for implementation requests (classifyPrompt kind "implement"): tier the request first
//     (rules/requirement-analysis.md). Switch: hooks.enforce.analysisReminder.
//   - the session's current model tier, so the model can tell when it does not fit the task
//     (rules/delegation.md): on Claude the effort level from the hook input (`effort.level`) when present,
//     otherwise, on both hosts, the model and effort the transcript recorded for the last answer (the
//     desktop app's hook input has no effort field). Switch: hooks.enforce.effortContext.
// Also logs the prompt kind and any rework signal (hooks.enforce.analysisLog) for the observation period,
// and whether the input carried an effort level (a probe: the desktop app's hook input is not documented).
// Never blocks. Switch: hooks.enforce.promptContext (off disables it).
// Usage: node prompt-context.mjs --host claude|codex   (JSON on stdin)
import { pathToFileURL } from 'node:url';
import { readStdinJson, hooksDisabled, loadHookConfig, appendLog, stateDir, enforceLevel, matchesAny, classifyPrompt, sessionTier } from './lib.mjs';

export { matchesAny };
const host = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'unknown';
export const MAX_CONTEXT = 600;
const ANALYSIS_NOTE = 'Implementation request: tier it first per rules/requirement-analysis.md and open with "Tier: … | Why: …"; from "brief" up, stop and wait for confirmation; ask when information is missing.';

export function localDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// The effort level only when it looks like one, so a hostile value cannot smuggle text into the context.
export function effortOf(input) {
  const level = input && input.effort && input.effort.level;
  return typeof level === 'string' && /^[a-z][a-z0-9-]{0,15}$/.test(level) ? level : null;
}

export function buildContext(prompt, cfg, now = new Date(), { host: h, effort, tier } = {}) {
  const parts = [`[rules-as-code] Today is ${localDate(now)} (local time).`];
  // Right after the date so the 600-char cap never cuts it.
  // Every prompt, so the answer always opens with the suggestion the user asked to see (2026-10-15).
  if ((h === 'claude' || h === 'codex') && enforceLevel(cfg, 'effortContext') !== 'off') {
    if (h === 'claude' && effort) parts.push(`Current effort: ${effort}.`);
    else if (tier) parts.push(`Current model tier: ${tier.model} · ${tier.effort} (from this session's last answer).`);
    else parts.push('Current model tier unknown.');
    parts.push(`Open with a bold line "Model tier: suggested … (current ${effort || tier ? '…' : 'unknown'})".`);
  }
  if (matchesAny(prompt, cfg.fastDomainKeywords)) {
    parts.push('Fast-moving topic: confirm the current version and date by search before trusting older sources; memory is not a source; grade sources per rules/source-grading.md, and a superseded source is × for claims about the present.');
  }
  if (matchesAny(prompt, cfg.reusePromptKeywords)) {
    parts.push('If this is a new project, feature or plan: search local projects, installed skills and GitHub first per rules/reuse-first.md and put a reuse assessment in the plan.');
  }
  if (enforceLevel(cfg, 'analysisReminder') !== 'off' && classifyPrompt(prompt, cfg).kind === 'implement') parts.push(ANALYSIS_NOTE);
  return parts.join(' ').slice(0, MAX_CONTEXT);
}

export function run(input, { cfg = loadHookConfig(), dir = stateDir(), host: h = host, now = new Date() } = {}) {
  if (hooksDisabled()) return null;
  const inputEffort = h === 'claude' ? effortOf(input) : null;
  let tier = null;
  if (!inputEffort && enforceLevel(cfg, 'effortContext') !== 'off') { try { tier = sessionTier(input && input.transcript_path, h); } catch { tier = null; } }
  const effort = inputEffort || (tier && tier.effort) || null;
  const probe = { hasEffort: !!(input && typeof input.effort === 'object' && input.effort !== null && 'level' in input.effort), effort,
    effortSource: inputEffort ? 'input' : tier ? 'transcript' : null, ...(tier && { model: tier.model }) };
  if (enforceLevel(cfg, 'promptContext') === 'off') {
    appendLog({ host: h, event: 'UserPromptSubmit', session: input.session_id, skipped: 'promptContext_off', ...probe }, dir);
    return null;
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const context = buildContext(prompt, cfg, now, { host: h, effort: inputEffort, tier });
  const cls = enforceLevel(cfg, 'analysisLog') !== 'off' ? classifyPrompt(prompt, cfg) : null;
  appendLog({ host: h, event: 'UserPromptSubmit', session: input.session_id, chars: context.length, ...probe, ...(cls && { kind: cls.kind, rework: cls.rework }) }, dir);
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = loadHookConfig();
  const killer = setTimeout(() => process.exit(0), cfg.budgetMs + 3000);
  try {
    const out = run(await readStdinJson(), { cfg });
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    appendLog({ host, event: 'UserPromptSubmit', error: String(err && err.message || err).slice(0, 300) });
  }
  clearTimeout(killer);
  process.exit(0);
}
