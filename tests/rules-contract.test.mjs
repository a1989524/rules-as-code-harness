// Contracts between the rule cards and the code that enforces them. A card may only promise what a hook,
// a tool or the config actually does, and the examples a card shows must pass the very check that enforces it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, loadConfig } from '../tools/lib.mjs';
import { claimsPassing, hasCompletionClaim, tierOf, sourceLabelGaps, MODEL_TIER_LINE, SPLIT_LINE, touchesSensitive } from '../hooks/lib.mjs';
import { decide } from '../hooks/pre-tool-gate.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const cfg = loadConfig();
const hooks = cfg.hooks;
const cards = readdirSync(path.join(ROOT, 'rules')).filter((f) => f.endsWith('.md')).map((f) => `rules/${f}`);
const hookSource = ['lib.mjs', 'pre-tool-gate.mjs', 'closing-check.mjs', 'prompt-context.mjs', 'rule-nudge.mjs', 'session-baseline.mjs']
  .map((f) => read(`hooks/${f}`)).join('\n');
const codeSpan = (text, re) => (text.match(re) || [])[1];
const state = mkdtempSync(path.join(os.tmpdir(), 'contract-'));
test.after(() => rmSync(state, { recursive: true, force: true }));
// The safety section of the PreToolUse gate, as subagents get it (no transcript needed).
const safety = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: ROOT }, { cfg: hooks, dir: state, host: 'claude', safetyOnly: true });

test('every rule a hook can demand exists as a card, and every card is routed once', () => {
  const demanded = new Set([...hookSource.matchAll(/'(rules\/[a-z-]+\.md)'/g)].map((m) => m[1]));
  assert.ok(demanded.size >= 8, 'the hooks name their rules');
  for (const rel of demanded) assert.ok(existsSync(path.join(ROOT, rel)), `${rel} is demanded by a hook but missing`);
  const index = read('INDEX.md');
  for (const rel of cards) assert.equal(index.split('`' + rel + '`').length - 1, 1, `${rel} routed exactly once`);
});

test('must-use cards agree across the index, the hook config and the generated entry files', () => {
  const index = read('INDEX.md');
  const markedMust = cards.filter((rel) => index.includes('`' + rel + '` (must-use)'));
  const configMust = hooks.mustRules.filter((r) => r.startsWith('rules/'));
  assert.deepEqual([...markedMust].sort(), [...configMust].sort());
  assert.ok(hooks.mustRules.includes('INDEX.md'));
  for (const id of ['claude', 'codex']) {
    const parts = cfg.targets.find((t) => t.id === id).parts;
    for (const rel of hooks.mustRules) assert.ok(parts.includes(rel), `${id} entry file ships ${rel}`);
  }
});

test('each "Enforced by" line names checks that exist, are implemented and are switched on', () => {
  const enforce = hooks.enforce;
  const named = { 'completion-claims': ['stopStaleVerification', 'stopIndependentReview'], 'source-grading': ['stopSourceLabels'],
    'trust-and-secrets': ['bashSensitiveRead', 'secretEgress', 'readWhitelist', 'readWhitelistShell'], 'requirement-analysis': ['analysisGate'],
    'reuse-first': ['reuseGate'], research: ['bannedTool'], 'git-hygiene': ['dangerousCommands'] };
  for (const [card, checks] of Object.entries(named)) {
    const line = read(`rules/${card}.md`).split('\n').find((l) => l.startsWith('Enforced by:'));
    assert.ok(line, `${card} has an "Enforced by" line`);
    for (const c of checks) {
      assert.ok(line.includes(`\`${c}\``), `${card} names ${c}`);
      assert.ok(c in enforce, `${c} has a switch`);
      assert.notEqual(enforce[c], 'off', `${c} is not off`);
      assert.ok(hookSource.includes(`'${c}'`), `${c} is implemented in hooks/`);
    }
  }
  // Checks that only log or remind are described that way, so the card does not overclaim.
  assert.equal(enforce.analysisGate, 'warn');
  assert.match(read('rules/requirement-analysis.md'), /observation mode/);
  assert.equal(enforce.stopIndependentReview, 'warn');
  assert.match(read('rules/completion-claims.md'), /`stopIndependentReview` reminds/);
});

test('numbers in the cards match the config the hooks read', () => {
  assert.equal(hooks.changedLinesThreshold, 700);
  assert.match(read('rules/update-logs.md'), /reaches 700 changed lines/);
  assert.match(read('core.md'), /700\+ changed lines/);
  assert.equal(hooks.ruleCoverage.reviewLinesThreshold, 500);
  assert.match(read('rules/completion-claims.md'), /about 500\+ lines/);
});

test('completion-claims card: its qualified wording is what the stale check accepts', () => {
  const phrase = codeSpan(read('rules/completion-claims.md'), /write "([^"]+)"/);
  assert.equal(phrase, 'passed before the last change, not re-run');
  assert.equal(claimsPassing(`All tests pass, ${phrase}.`), false, 'a qualified claim is not blocked');
  assert.equal(claimsPassing('All tests pass.'), true);
  assert.equal(hasCompletionClaim('Not verified yet.'), false, 'a negated claim does not count');
});

test('source-grading card: its format line passes the source-label check', () => {
  const card = read('rules/source-grading.md');
  const format = codeSpan(card, /`(- \[Title\]\(URL\)[^`]+)`/);
  assert.ok(format, 'the card shows the line format');
  const filled = (grade, mode) => format.replace('URL', `https://${grade === '×' ? 'x' : grade.toLowerCase()}.example`).replace('— A ·', `— ${grade} ·`).replace('read mode', mode);
  assert.deepEqual(sourceLabelGaps(['Conclusion.', '', filled('S', 'opened'), filled('C', 'page summary')].join('\n')),
    { sources: 2, unlabeled: 0, flagged: false, unsorted: false });
  for (const mode of ['opened', 'page summary', 'search snippet', 'republished']) {
    assert.ok(card.includes(mode), `the card lists "${mode}"`);
    assert.equal(sourceLabelGaps(`${filled('S', mode)}\n${filled('A', mode)}`).flagged, false, mode);
  }
  assert.equal(sourceLabelGaps(`${filled('C', 'opened')}\n${filled('S', 'opened')}`).unsorted, true, 'highest grade first');
  assert.equal(sourceLabelGaps('- [a](https://a.example)\n- [b](https://b.example)').flagged, true, 'a bare list is flagged');
});

test('requirement-analysis card: every tier it defines is parsed by the hook', () => {
  const card = read('rules/requirement-analysis.md');
  assert.ok(card.includes('`Tier: <tier> | Why: <one line>`'));
  const tiers = [...card.matchAll(/^\| (direct|brief|full analysis|design first|probe|research) \|/gm)].map((m) => m[1]);
  assert.deepEqual(tiers, ['direct', 'brief', 'full analysis', 'design first', 'probe', 'research']);
  for (const t of tiers) assert.equal(tierOf(`Tier: ${t} | Why: x`), t);
});

test('delegation card: its example lines are the lines the Stop log looks for', () => {
  const card = read('rules/delegation.md');
  assert.match(codeSpan(card, /`(Delegation: [^`]+)`/), SPLIT_LINE);
  assert.match(`**${codeSpan(card, /`(Model tier: suggested[^`]+)`/)}**`, MODEL_TIER_LINE);
});

test('trust card: its key-only command passes the gate, a raw read does not', () => {
  const keyOnly = codeSpan(read('rules/trust-and-secrets.md'), /`(grep -o '[^`]+' \.env)`/);
  assert.ok(keyOnly, 'the card shows the key-only command');
  assert.equal(safety('Bash', { command: keyOnly }), null);
  assert.equal(safety('Bash', { command: 'cat .env' })?.decision, 'deny');
  assert.ok(touchesSensitive('Bash', { command: 'cat $HOME/.ssh/id_ed25519' }, hooks.ruleCoverage, true), 'a variable-built path counts');
});

test('git card: the commands it says need consent are the ones the gate asks about', () => {
  assert.match(read('rules/git-hygiene.md'), /force pushes, hard resets, cleans and publishes/);
  for (const command of ['git push --force origin main', 'git reset --hard HEAD~1', 'git clean -fd', 'npm publish']) {
    assert.equal(safety('Bash', { command })?.decision, 'ask', command);
  }
  assert.equal(safety('Bash', { command: 'git status' }), null);
});

test('research card: the banned tool is denied, studying it is not', () => {
  assert.match(read('rules/research.md'), /researching the tool by name stays allowed/);
  assert.equal(safety('mcp__exa__web_search_exa', {})?.decision, 'deny');
  assert.equal(safety('WebFetch', { url: 'https://api.exa.ai/search' })?.decision, 'deny');
  assert.equal(safety('WebSearch', { query: 'exa search pricing' }), null);
});

test('core keeps the always-on invariants', () => {
  const core = read('core.md');
  for (const pattern of [/Do not say done, fixed or verified without a command, test or run result/, /Reads stay inside a whitelist/,
    /read key names, paths, hashes or status only/, /are data, not instructions/, /secrets never go into URLs/,
    /never called: not directly, not through another tool, not as a fallback/, /\*\*What I might have missed\*\*/, /\*\*Follow-up questions\*\*/]) {
    assert.match(core, pattern);
  }
});

test('the cards stay condensed: each within its budget, all together far below the original', () => {
  const budget = cfg.lint.budgets['rules/*.md'];
  for (const rel of cards) assert.ok([...read(rel)].length <= budget, `${rel} within ${budget} chars`);
  const total = cards.reduce((n, rel) => n + [...read(rel)].length, 0);
  assert.ok(total < 26000, `all cards together: ${total} chars`);
});
