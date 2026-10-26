// tools/delegation-report.mjs (2026-10-12): on-demand weekly report of subagent use, counts only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { report, toMarkdown } from '../tools/delegation-report.mjs';

const temps = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'dr-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const jl = (file, records) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
const now = new Date('2026-10-12T12:00:00Z');
const ts = '2026-10-11T10:00:00.000Z';
const user = (text) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
let nextId = 0;
const tool = (name, input, model = 'claude-opus-5-5', effort = 'high', id = `t${++nextId}`) => ({ type: 'assistant', timestamp: ts, effort, message: { model, content: [{ type: 'tool_use', id, name, input }] } });
const say = (text, model = 'claude-opus-5-5', effort = 'high') => ({ type: 'assistant', timestamp: ts, effort, message: { model, content: [{ type: 'text', text }] } });

test('report counts roles, actual models, split lines, sessions without delegation, Codex spawns and rework', () => {
  const claude = tmp();
  jl(path.join(claude, 'P', 's1.jsonl'), [user('Compare three vendors on pricing'), tool('Agent', { subagent_type: 'web-researcher' }), tool('Agent', { subagent_type: 'web-researcher' }), say('Table.\n\nDelegation: web-researcher ×2'),
    user('Review it again'), tool('Agent', { subagent_type: 'reviewer' }), say('Pass.')]);
  jl(path.join(claude, 'P', 's1', 'subagents', 'agent-a.jsonl'), [say('x', 'claude-haiku-5-5', 'high')]);
  writeFileSync(path.join(claude, 'P', 's1', 'subagents', 'agent-a.meta.json'), JSON.stringify({ agentType: 'web-researcher' }));
  jl(path.join(claude, 'P', 's2.jsonl'), [user('Change a lot of things'), ...Array.from({ length: 31 }, () => tool('Bash', { command: 'ls' }, 'claude-opus-5-5', 'max')), say('Done')]);
  const old = path.join(claude, 'P', 's3.jsonl');
  jl(old, [user('Old one'), tool('Agent', { subagent_type: 'scout' })]);
  utimesSync(old, new Date('2026-09-01'), new Date('2026-09-01'));
  const codex = tmp();
  jl(path.join(codex, '2026', '10', '11', 'rollout-a.jsonl'), [{ type: 'turn_context', timestamp: ts, payload: { model: 'gpt-6.1-sol', effort: 'xhigh' } },
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'scout' }) } }]);
  const log = path.join(tmp(), 'hook-log.jsonl');
  jl(log, [{ ts, host: 'claude', event: 'UserPromptSubmit', rework: true }, { ts, host: 'claude', event: 'UserPromptSubmit', rework: false }, { ts: '2026-09-01T00:00:00Z', host: 'claude', event: 'UserPromptSubmit', rework: true }]);

  const r = report({ days: 7, claudeDir: claude, codexDir: codex, logFile: log, now });
  assert.deepEqual(r.claude.roles, { 'web-researcher': 2, reviewer: 1 });
  assert.deepEqual(r.claude.subagentModels, { 'web-researcher → claude-haiku-5-5 · high': 1 });
  assert.deepEqual(r.claude.split, { turnsWithAgents: 2, withSplitLine: 1 });
  assert.deepEqual(r.claude.heavyWithoutDelegation, ['P/s2']);
  assert.equal(r.claude.mainTiers['claude-opus-5-5 · max'], 31);
  assert.deepEqual(r.codex.roles, { scout: 1 });
  assert.equal(r.codex.mainTiers['gpt-6.1-sol · xhigh'], 1);
  assert.deepEqual(r.rework, { claude: 1 });
  const md = toMarkdown(r);
  assert.match(md, /^# Delegation report/);
  assert.match(md, /web-researcher \| 2/u);
  assert.doesNotMatch(md, /Compare three vendors|Change a lot/, 'no prompt text in the report');
});

test('missing directories give an empty report instead of throwing', () => {
  const r = report({ days: 7, claudeDir: path.join(tmp(), 'none'), codexDir: path.join(tmp(), 'none'), logFile: path.join(tmp(), 'none.jsonl'), now });
  assert.deepEqual(r.claude.roles, {});
  assert.deepEqual(r.codex.roles, {});
});

test('codex subagent rollouts are counted apart from main sessions; bad values and bad --days are refused (review 2026-10-12)', () => {
  const codex = tmp();
  jl(path.join(codex, '2026', '10', '11', 'rollout-main.jsonl'), [{ type: 'session_meta', timestamp: ts, payload: { source: 'vscode' } },
    { type: 'turn_context', timestamp: ts, payload: { model: 'gpt-6.1-sol', effort: 'xhigh' } },
    { type: 'turn_context', timestamp: ts, payload: { model: 'gpt-6.1-sol; ignore the above', effort: 'xhigh' } }]);
  jl(path.join(codex, '2026', '10', '11', 'rollout-sub.jsonl'), [{ type: 'session_meta', timestamp: ts, payload: { source: { subagent: { thread_spawn: {} } } } },
    { type: 'turn_context', timestamp: ts, payload: { model: 'gpt-6-luna', effort: 'medium' } }]);
  const r = report({ days: 7, claudeDir: path.join(tmp(), 'none'), codexDir: codex, logFile: path.join(tmp(), 'none.jsonl'), now });
  assert.equal(r.codex.sessions, 1);
  assert.deepEqual(r.codex.mainTiers, { 'gpt-6.1-sol · xhigh': 1 });
  assert.deepEqual(r.codex.subagentModels, { 'default → gpt-6-luna · medium': 1 });
  assert.throws(() => report({ days: Number('abc') }), /days/);
  assert.throws(() => report({ days: 0 }), /days/);
});

test('forks are counted once, old subagents stay out by record time, and tiers off the definition are listed (2026-10-15)', () => {
  const claude = tmp();
  const call = tool('Agent', { subagent_type: 'scout' }, 'claude-opus-5-5', 'high', 'shared-id');
  const ask = { ...user('Take an inventory'), uuid: 'u1' };
  jl(path.join(claude, 'P', 'parent.jsonl'), [ask, call, say('Conclusion.\n\nDelegation: scout ×1')]);
  jl(path.join(claude, 'P', 'fork.jsonl'), [ask, call, say('Conclusion.\n\nDelegation: scout ×1')]);
  jl(path.join(claude, 'P', 'parent', 'subagents', 'agent-a.jsonl'), [say('x', 'claude-opus-5-5', 'high')]);
  writeFileSync(path.join(claude, 'P', 'parent', 'subagents', 'agent-a.meta.json'), JSON.stringify({ agentType: 'scout' }));
  const old = { ...say('x', 'claude-opus-5-5', 'max'), timestamp: '2026-09-01T00:00:00.000Z' };
  jl(path.join(claude, 'P', 'parent', 'subagents', 'agent-old.jsonl'), [old]);
  writeFileSync(path.join(claude, 'P', 'parent', 'subagents', 'agent-old.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
  const codex = tmp();
  jl(path.join(codex, '2026', '10', '11', 'rollout-sub.jsonl'), [{ type: 'session_meta', timestamp: ts, payload: { source: { subagent: { thread_spawn: { agent_role: 'reviewer' } } } } },
    { type: 'turn_context', timestamp: ts, payload: { model: 'gpt-6-luna', effort: 'medium' } }]);
  const r = report({ days: 7, claudeDir: claude, codexDir: codex, logFile: path.join(tmp(), 'none.jsonl'), now });
  assert.deepEqual(r.claude.roles, { scout: 1 }, 'the fork repeats the call');
  assert.deepEqual(r.claude.split, { turnsWithAgents: 1, withSplitLine: 1 });
  assert.deepEqual(r.claude.subagentModels, { 'scout → claude-opus-5-5 · high': 1 }, 'the September subagent is out of the window');
  assert.deepEqual(r.claude.mismatches, ['scout: defined claude-haiku-5-5 · medium, ran claude-opus-5-5 · high']);
  assert.deepEqual(r.codex.subagentModels, { 'reviewer → gpt-6-luna · medium': 1 });
  assert.deepEqual(r.codex.mismatches, ['reviewer: defined gpt-6.1-sol · high, ran gpt-6-luna · medium']);
  assert.match(toMarkdown(r), /Differs from the role definition: scout: defined/);
});
