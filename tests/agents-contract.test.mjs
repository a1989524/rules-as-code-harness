// Contracts of the example subagent definitions. They are copied verbatim into ~/.claude/agents/ and
// ~/.codex/agents/ by the dir targets in adapters.json, so a broken frontmatter silently breaks the role.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, expand, loadConfig } from '../tools/lib.mjs';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FULL_ID = /^claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?$/;
// Role -> the tier chosen in docs/model-tier-method.md "Resulting roles".
const EXPECTED = {
  scout: { model: 'claude-haiku-5-5', effort: 'medium' },
  reviewer: { model: 'claude-opus-5-5', effort: 'high' },
  implementer: { model: 'claude-opus-5-5', effort: 'medium' },
};

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'YAML frontmatter on line 1');
  return Object.fromEntries(m[1].split('\n').map((l) => l.match(/^([A-Za-z]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
}
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const agent = (n) => readFileSync(path.join(ROOT, 'agents', 'claude', `${n}.md`), 'utf8');

test('every agent file has a valid frontmatter with a pinned model and effort', () => {
  const files = expand(ROOT, 'agents/claude/*.md');
  assert.deepEqual(files.map((f) => path.posix.basename(f, '.md')).sort(), Object.keys(EXPECTED).sort());
  for (const rel of files) {
    const name = path.posix.basename(rel, '.md');
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    const fm = frontmatter(text);
    assert.equal(fm.name, name, `${rel}: name matches the file name`);
    assert.match(fm.description, /^Use proactively\. .{40,}/, `${rel}: says when to use it, with the phrase that encourages delegation`);
    assert.match(fm.model, FULL_ID, `${rel}: a full model id, not an alias an environment override can redirect`);
    assert.ok(EFFORTS.includes(fm.effort), `${rel}: effort is a valid level`);
    assert.deepEqual({ model: fm.model, effort: fm.effort }, EXPECTED[name], `${rel}: tier as decided`);
    // Subagents load the same entry file as the parent, so they must be told not to write the parent's lines.
    assert.match(text, /No tier line and no closing sections\./, `${rel}: report format excludes the parent's lines`);
  }
});

test('read-only roles cannot write, and no role can spawn further subagents', () => {
  for (const name of ['scout', 'reviewer']) {
    const fm = frontmatter(agent(name));
    for (const tool of ['Write', 'Edit']) {
      assert.ok(list(fm.disallowedTools).includes(tool), `${name} disallows ${tool}`);
      assert.ok(!list(fm.tools).includes(tool), `${name} is not given ${tool}`);
    }
  }
  for (const name of Object.keys(EXPECTED)) {
    const fm = frontmatter(agent(name));
    assert.ok(list(fm.tools).length > 0, `${name} lists its tools explicitly`);
    assert.ok(!list(fm.tools).includes('Agent'), `${name} cannot spawn subagents`);
  }
});

test('the implementer writes inside its brief, with bounded retries and no irreversible commands', () => {
  const fm = frontmatter(agent('implementer'));
  for (const tool of ['Read', 'Edit', 'Write', 'Bash']) assert.ok(list(fm.tools).includes(tool), `implementer has ${tool}`);
  const body = agent('implementer');
  for (const p of [/Change only the files and scope in the brief/, /At most two fix rounds/, /No commits, pushes/, /isolated copy/]) assert.match(body, p);
});

test('the reviewer is not below the implementer (rules/delegation.md)', () => {
  const rank = (fm) => ({ haiku: 0, sonnet: 1, opus: 2 }[fm.model.split('-')[1]] * 10 + EFFORTS.indexOf(fm.effort));
  assert.ok(rank(frontmatter(agent('reviewer'))) >= rank(frontmatter(agent('implementer'))));
});

test('the dir targets sync agents/ into the user agent directories', () => {
  const targets = loadConfig(ROOT).targets;
  for (const [id, source, dir] of [['claude-agents', 'agents/claude/*.md', '~/.claude/agents'], ['codex-agents', 'agents/codex/*.toml', '~/.codex/agents']]) {
    const t = targets.find((x) => x.id === id);
    assert.ok(t, `adapters.json has the ${id} target`);
    assert.deepEqual([t.mode, t.source, t.path], ['dir', source, dir]);
  }
});

// Codex custom agents must define name, description and developer_instructions; model,
// model_reasoning_effort and sandbox_mode override the parent session.
const tomlString = (text, key) => { const m = text.match(new RegExp(`^${key} = "([^"\n]*)"$`, 'm')); return m ? m[1] : null; };

test('codex agents: required keys, pinned tier and sandbox, one closed instruction block', () => {
  const files = expand(ROOT, 'agents/codex/*.toml');
  assert.deepEqual(files.map((f) => path.posix.basename(f, '.toml')), ['reviewer']);
  const text = readFileSync(path.join(ROOT, files[0]), 'utf8');
  assert.equal(tomlString(text, 'name'), 'reviewer');
  assert.ok((tomlString(text, 'description') || '').length >= 20, 'description says when to use it');
  assert.deepEqual({ effort: tomlString(text, 'model_reasoning_effort'), sandbox: tomlString(text, 'sandbox_mode') }, { effort: 'high', sandbox: 'read-only' });
  assert.equal(tomlString(text, 'model'), 'gpt-6.1-sol', 'a pinned model');
  assert.equal((text.match(/'''/g) || []).length, 2, 'one literal developer_instructions block');
  assert.match(text, /^developer_instructions = '''\n/m);
  assert.match(text, /No tier line and no closing sections\./);
  assert.doesNotMatch(text, /\r/, 'LF only');
});
