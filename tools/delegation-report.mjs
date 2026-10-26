#!/usr/bin/env node
// On-demand delegation report (rules/delegation.md). Reads the session transcripts of
// the last N days and prints counts only, never prompt or answer text:
//   - Claude: subagent calls by role, the model and effort each subagent actually ran on, how many turns
//     that delegated also wrote the "Delegation:" line, sessions with 30+ tool calls and no delegation, and the
//     main sessions' model · effort;
//   - Codex: spawn_agent calls by role and the main sessions' model · effort;
//   - rework signals from the hook log.
// It reads every project's transcripts, which is outside the read whitelist: run it only when the user asks.
//   node tools/delegation-report.mjs [--days 7] [--claude-dir <dir>] [--codex-dir <dir>] [--log <file>] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SPLIT_LINE, stateDir } from '../hooks/lib.mjs';
import { ROOT } from './lib.mjs';

const HEAVY_TOOL_CALLS = 30;
const add = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };
// Same shape checks as the hooks: a model id and an effort level, nothing else.
const MODEL_RE = /^[a-z][a-z0-9.-]{1,40}$/;
const EFFORT_RE = /^[a-z][a-z0-9-]{0,15}$/;
const tierKey = (model, effort) => (typeof model === 'string' && MODEL_RE.test(model) ? `${model} · ${typeof effort === 'string' && EFFORT_RE.test(effort) ? effort : '?'}` : null);
const role = (v, dflt) => (typeof v === 'string' && /^[A-Za-z][\w-]{0,40}$/.test(v) ? v : dflt);

function jsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* skip */ } }
  return out;
}
function recent(file, since) { try { return fs.statSync(file).mtimeMs >= since; } catch { return false; } }
function walk(dir, depth, pick, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, pick, out);
    else if (e.isFile() && pick(e.name)) out.push(p);
  }
  return out;
}
const inWindow = (o, since) => !o.timestamp || Date.parse(o.timestamp) >= since;
const isPrompt = (o) => o.type === 'user' && !o.isMeta && !o.isCompactSummary
  && (typeof o.message?.content === 'string' ? !o.message.content.startsWith('<')
    : Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === 'text') && !o.message.content.some((b) => b.type === 'tool_result'));

// The tier each role is pinned to, read from the definitions in agents/claude/*.md and agents/codex/*.toml.
export function expectedTiers(root = ROOT) {
  const out = { claude: {}, codex: {} };
  for (const f of walk(path.join(root, 'agents', 'claude'), 0, (n) => n.endsWith('.md'))) {
    const fm = (fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---\n/) || [])[1] || '';
    const v = (k) => ((fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1] || '').trim();
    if (v('name')) out.claude[v('name')] = tierKey(v('model'), v('effort'));
  }
  for (const f of walk(path.join(root, 'agents', 'codex'), 0, (n) => n.endsWith('.toml'))) {
    const t = fs.readFileSync(f, 'utf8');
    const v = (k) => (t.match(new RegExp(`^${k} = "([^"\\n]*)"$`, 'm')) || [])[1] || '';
    if (v('name')) out.codex[v('name')] = tierKey(v('model'), v('model_reasoning_effort'));
  }
  return out;
}

// Forked sessions copy the parent's history, so calls, turns and answers are counted once by their ids.
function claudeReport(dir, since, expected = {}) {
  const r = { roles: {}, subagentModels: {}, split: { turnsWithAgents: 0, withSplitLine: 0 }, heavyWithoutDelegation: [], mainTiers: {}, sessions: 0, mismatches: [] };
  const seenCalls = new Set(); const seenTurns = new Set(); const seenAnswers = new Set();
  for (const project of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
    const pdir = path.join(dir, project);
    for (const name of (() => { try { return fs.readdirSync(pdir); } catch { return []; } })()) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(pdir, name);
      if (!recent(file, since)) continue;
      r.sessions += 1;
      let tools = 0; let agents = 0; let turnAgents = 0; let lastText = ''; let turnKey = null;
      const close = () => {
        if (turnAgents && !seenTurns.has(turnKey)) { seenTurns.add(turnKey); r.split.turnsWithAgents += 1; if (SPLIT_LINE.test(lastText)) r.split.withSplitLine += 1; }
        turnAgents = 0; lastText = '';
      };
      for (const o of jsonl(file)) {
        if (!inWindow(o, since)) continue;
        if (isPrompt(o)) { close(); turnKey = o.uuid || `${o.timestamp}|${JSON.stringify(o.message.content).slice(0, 200)}`; continue; }
        if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
        const fresh = !o.uuid || !seenAnswers.has(o.uuid);
        if (o.uuid) seenAnswers.add(o.uuid);
        const main = fresh && typeof o.effort === 'string' ? tierKey(o.message.model, o.effort) : null;
        if (main) add(r.mainTiers, main);
        for (const b of o.message.content) {
          if (b.type === 'text') lastText = b.text;
          if (b.type !== 'tool_use') continue;
          tools += 1;
          if (b.name === 'Agent' || b.name === 'Task') {
            agents += 1; turnAgents += 1;
            if (!b.id || !seenCalls.has(b.id)) { if (b.id) seenCalls.add(b.id); add(r.roles, role(b.input?.subagent_type, 'general-purpose')); }
          }
        }
      }
      close();
      if (tools >= HEAVY_TOOL_CALLS && !agents) r.heavyWithoutDelegation.push(`${project}/${name.replace(/\.jsonl$/, '')}`);
      const sub = path.join(pdir, name.replace(/\.jsonl$/, ''), 'subagents');
      for (const s of walk(sub, 0, (n) => n.endsWith('.jsonl'))) {
        let type = '?';
        try { type = role(JSON.parse(fs.readFileSync(s.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType, '?'); } catch { /* no meta */ }
        // By the records' own time, not the file's: an old subagent in a recently touched session stays out.
        const seen = new Set();
        for (const o of jsonl(s)) { const k = o.type === 'assistant' && inWindow(o, since) ? tierKey(o.message?.model, o.effort) : null; if (k) seen.add(k); }
        for (const t of seen) {
          add(r.subagentModels, `${type} → ${t}`);
          if (expected[type] && expected[type] !== t) r.mismatches.push(`${type}: defined ${expected[type]}, ran ${t}`);
        }
      }
    }
  }
  return r;
}

function codexReport(dir, since, expected = {}) {
  const r = { roles: {}, mainTiers: {}, subagentModels: {}, sessions: 0, subagentSessions: 0, mismatches: [] };
  for (const file of walk(dir, 4, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
    if (!recent(file, since)) continue;
    const records = jsonl(file);
    // A subagent's own rollout: its session_meta source names the spawning thread.
    const meta = records.find((o) => o.type === 'session_meta');
    const src = meta && meta.payload && meta.payload.source;
    const sub = !!(src && typeof src === 'object' && src.subagent);
    // The role the parent asked for, recorded by the host on the child's session_meta.
    const spawn = sub && src.subagent && typeof src.subagent === 'object' ? src.subagent.thread_spawn || {} : {};
    const subRole = role(spawn.agent_role, 'default');
    if (sub) r.subagentSessions += 1; else r.sessions += 1;
    const seen = new Set();
    for (const o of records) {
      if (!inWindow(o, since)) continue;
      const p = o.payload || {};
      const k = o.type === 'turn_context' ? tierKey(p.model, p.effort || p.reasoning_effort) : null;
      if (k && sub) seen.add(k); else if (k) add(r.mainTiers, k);
      if (o.type === 'response_item' && p.type === 'function_call' && p.name === 'spawn_agent') {
        let a = {}; try { a = JSON.parse(p.arguments || '{}'); } catch { a = {}; }
        add(r.roles, role([a.agent_type, a.agent, a.agent_name, a.role].find((v) => typeof v === 'string'), 'default'));
      }
    }
    for (const k of seen) {
      add(r.subagentModels, `${subRole} → ${k}`);
      if (expected[subRole] && expected[subRole] !== k) r.mismatches.push(`${subRole}: defined ${expected[subRole]}, ran ${k}`);
    }
  }
  return r;
}

export function report({ days = 7, claudeDir = path.join(os.homedir(), '.claude', 'projects'), codexDir = path.join(os.homedir(), '.codex', 'sessions'),
  logFile = path.join(stateDir(), 'hook-log.jsonl'), now = new Date(), root = ROOT } = {}) {
  if (!Number.isFinite(days) || days <= 0) throw new RangeError(`days must be a positive number, got ${days}`);
  const since = now.getTime() - days * 24 * 3600 * 1000;
  const rework = {};
  for (const o of jsonl(logFile)) if (o.event === 'UserPromptSubmit' && o.rework === true && Date.parse(o.ts || 0) >= since) add(rework, o.host || '?');
  const expected = expectedTiers(root);
  return { days, since: new Date(since).toISOString(), claude: claudeReport(claudeDir, since, expected.claude), codex: codexReport(codexDir, since, expected.codex), rework };
}

const table = (obj, head) => {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return rows.length ? [`| ${head} | Count |`, '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n') : '(none)';
};
export function toMarkdown(r) {
  const c = r.claude;
  const rate = c.split.turnsWithAgents ? `${c.split.withSplitLine}/${c.split.turnsWithAgents}` : '0/0';
  return [
    `# Delegation report (last ${r.days} days, since ${r.since.slice(0, 10)})`, '',
    `## Claude (${c.sessions} sessions)`, '', '### Calls by role', table(c.roles, 'Role'), '',
    '### Models the subagents actually ran on', table(c.subagentModels, 'Role → model · effort'), '',
    `- Differs from the role definition: ${c.mismatches.length ? c.mismatches.join('; ') : 'none'}`,
    `- Delegating turns whose answer has the "Delegation:" line: ${rate}`,
    `- Sessions with ${HEAVY_TOOL_CALLS}+ tool calls and no delegation: ${c.heavyWithoutDelegation.length ? c.heavyWithoutDelegation.join(', ') : 'none'}`, '',
    '### Main-session model tier (by answers)', table(c.mainTiers, 'Model · effort'), '',
    `## Codex (${r.codex.sessions} main sessions, ${r.codex.subagentSessions} subagent sessions)`, '', '### Calls by role', table(r.codex.roles, 'Role'), '',
    '### Models the subagents actually ran on', table(r.codex.subagentModels, 'Role → model · effort'), '',
    `- Differs from the role definition: ${r.codex.mismatches.length ? r.codex.mismatches.join('; ') : 'none'}`, '',
    '### Main-session model tier (by turns)', table(r.codex.mainTiers, 'Model · effort'), '',
    '## Rework signals (hook log)', table(r.rework, 'Host'), '',
  ].join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const opts = { ...(arg('--days') && { days: Number(arg('--days')) }), ...(arg('--claude-dir') && { claudeDir: arg('--claude-dir') }),
    ...(arg('--codex-dir') && { codexDir: arg('--codex-dir') }), ...(arg('--log') && { logFile: arg('--log') }) };
  let r;
  try { r = report(opts); } catch (err) { process.stderr.write(`${err.message}
`); process.exit(1); }
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(r, null, 2)}\n` : `${toMarkdown(r)}`);
}
