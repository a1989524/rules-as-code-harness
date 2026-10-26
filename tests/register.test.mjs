import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hookEntries, mergeHooks, register } from '../tools/register-hooks.mjs';

test('codex commands start with an unquoted token and carry commandWindows', () => {
  const e = hookEntries('codex', 'C:/Users/me/rules-as-code-harness');
  const h = e.Stop[0].hooks[0];
  assert.match(h.command, /^node C:\/Users\/me\/rules-as-code-harness\/hooks\/closing-check\.mjs --host codex$/);
  assert.equal(h.commandWindows, h.command);
  assert.match(e.SessionStart[0].matcher, /compact/);
  assert.match(hookEntries('claude').SessionStart[0].matcher, /compact/, 'Claude re-injects the reminder after compaction too');
  assert.equal(hookEntries('claude').PostToolUse[0].matcher, '*', 'nudge sees every tool');
  assert.match(hookEntries('claude').PostToolUse[0].hooks[0].command, /rule-nudge\.mjs --host claude$/);
  assert.equal(e.PostToolUse, undefined, 'codex has no PostToolUse nudge');
});

test('both hosts register the pre-tool gate and the prompt-context hook', () => {
  for (const host of ['claude', 'codex']) {
    const e = hookEntries(host, 'C:/Users/me/rules-as-code-harness');
    assert.match(e.PreToolUse[0].hooks[0].command, new RegExp(`pre-tool-gate\\.mjs --host ${host}$`));
    assert.match(e.UserPromptSubmit[0].hooks[0].command, new RegExp(`prompt-context\\.mjs --host ${host}$`));
  }
  assert.equal(hookEntries('claude').PreToolUse[0].matcher, '*', 'Claude gate sees every tool');
  assert.equal(hookEntries('codex').PreToolUse[0].matcher, undefined, 'Codex: no matcher means every tool');
});

test('merge keeps foreign hooks and replaces only ours', () => {
  const foreign = { hooks: [{ type: 'command', command: 'echo other' }] };
  const merged = mergeHooks({ Stop: [foreign], PreToolUse: [foreign] }, hookEntries('claude'));
  const again = mergeHooks(merged, hookEntries('claude'));
  assert.equal(again.Stop.length, 2);
  assert.equal(again.PreToolUse.length, 2, 'foreign PreToolUse kept next to ours');
  assert.deepEqual(again.PreToolUse[0], foreign);
});

test('register preserves every non-hook key in settings.json', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'reg-home-'));
  try {
    mkdirSync(path.join(home, '.claude'));
    const original = { model: 'x', env: { A: '1' }, theme: 'dark' };
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(original));
    register('claude', { home, backupRoot: path.join(home, 'backups') });
    const after = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual({ model: after.model, env: after.env, theme: after.theme }, original);
    assert.ok(after.hooks.Stop && after.hooks.SessionStart);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
