// evals/replay.mjs on two synthetic sessions (evals/fixtures/projects): a git worktree command with the git
// rule unread, and a pass claim made stale by a later edit.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../tools/lib.mjs';

const replay = (...args) => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'replay.mjs'), ...args, '--projects', path.join(ROOT, 'evals', 'fixtures', 'projects')],
    { encoding: 'utf8', env: { ...process.env, AGENT_PROMPTS_HOOKS: '' } });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

test('replay gate: the next tool call is judged as the hook would have judged it then', () => {
  const out = replay('gate', '--session', 'replay-git', '--at', '2026-10-01T10:00:08.000Z');
  assert.equal(out.tool, 'Bash');
  assert.equal(out.result.check, 'sceneRuleGate');
  assert.equal(out.result.decision, 'deny');
  assert.match(out.result.reason, /rules\/git-hygiene\.md \(a git operation\)/);
});

test('replay stop: a pass claim after a later edit is blocked, naming the stale check', () => {
  const out = replay('stop', '--session', 'replay-stale', '--at', '2026-10-02T09:05:00.000Z');
  assert.equal(out.decision, 'block');
  assert.equal(out.stale.status, 'checked');
  assert.deepEqual(out.stale.stale, ['npm test']);
  assert.match(out.reason, /csv\.js/);
  assert.doesNotMatch(out.reason, /export\.js/, 'the edit before the test run is not stale');
});
