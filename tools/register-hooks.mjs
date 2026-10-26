#!/usr/bin/env node
// Register the shared hooks with Claude Code and/or Codex.
//   node tools/register-hooks.mjs --host claude|codex [--dry-run]
// Claude: merges a "hooks" key into ~/.claude/settings.json, leaving every other key untouched.
// Codex:  writes ~/.codex/hooks.json (merging with existing events if the file exists).
// The previous file is backed up to <backupRoot>/prompt-hooks-<ts>/ with a sha256 manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig, sha256, writeAtomic, timestamp, expandHome } from './lib.mjs';

// Our entries, wherever the repo lives: a command that runs one of these hook scripts.
const MARK = /\/hooks\/(?:session-baseline|pre-tool-gate|prompt-context|closing-check|rule-nudge)\.mjs\b/;

export function hookEntries(host, root = ROOT) {
  const script = (name) => `${root.replace(/\\/g, '/')}/hooks/${name}`;
  const cmd = (name) => `node ${script(name)} --host ${host}`; // first token unquoted (Codex on Windows)
  const make = (name) => {
    const h = { type: 'command', command: cmd(name), timeout: 15 };
    if (host === 'codex') h.commandWindows = cmd(name);
    return h;
  };
  const entries = {
    // compact on both hosts: scene rules read earlier are summarized away, so the reminder asks for them again.
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [make('session-baseline.mjs')] }],
    // Checks before every tool call (secrets, Exa, dangerous commands, scene-rule and reuse gates).
    PreToolUse: [{ ...(host === 'claude' && { matcher: '*' }), hooks: [make('pre-tool-gate.mjs')] }],
    // Adds today's date and fast-domain / reuse reminders to each prompt.
    UserPromptSubmit: [{ hooks: [make('prompt-context.mjs')] }],
    Stop: [{ hooks: [make('closing-check.mjs')] }],
  };
  // Rule nudges need Claude's PostToolUse additionalContext. Every tool is matched; scene rules only,
  // since must-use rules ship in the entry file; hooks.ruleCoverage.nudgeSkipTools filters inside the script.
  if (host === 'claude') entries.PostToolUse = [{ matcher: '*', hooks: [make('rule-nudge.mjs')] }];
  return entries;
}

// Replace our own entries (identified by MARK) and keep everything else.
export function mergeHooks(existing = {}, ours) {
  const out = { ...existing };
  for (const [event, groups] of Object.entries(ours)) {
    const kept = (out[event] || []).filter((g) => !(g.hooks || []).some((h) => MARK.test(String(h.command || '').replace(/\\/g, '/'))));
    out[event] = [...kept, ...groups];
  }
  return out;
}

export function register(host, { dryRun = false, home = os.homedir(), root = ROOT, backupRoot } = {}) {
  const file = host === 'claude' ? path.join(home, '.claude', 'settings.json') : path.join(home, '.codex', 'hooks.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const doc = before ? JSON.parse(before.toString('utf8').replace(/^﻿/, '')) : {};
  const otherKeys = JSON.stringify(Object.keys(doc).filter((k) => k !== 'hooks').sort().map((k) => [k, doc[k]]));
  doc.hooks = mergeHooks(doc.hooks, hookEntries(host, root));
  const after = JSON.stringify(doc, null, 2) + '\n';
  const check = JSON.parse(after);
  if (JSON.stringify(Object.keys(check).filter((k) => k !== 'hooks').sort().map((k) => [k, check[k]])) !== otherKeys) {
    throw new Error('non-hook keys changed during merge; aborting');
  }
  let backup = null;
  if (!dryRun) {
    if (before) {
      // The host is part of the name: registering both hosts in the same second must not share a manifest.
      const dir = path.join(expandHome(backupRoot || loadConfig(root).backupRoot), `prompt-hooks-${host}-${timestamp()}`);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, path.basename(file));
      fs.writeFileSync(dest, before);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 'prompt_hooks_manifest_v1', path: file, backup: path.basename(file), preimage_sha256: sha256(before), postimage_sha256: sha256(Buffer.from(after)) }, null, 2) + '\n');
      backup = dir;
    }
    writeAtomic(file, after);
  }
  return { file, backup, dryRun, events: Object.keys(doc.hooks) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const host = args[args.indexOf('--host') + 1];
  if (!['claude', 'codex'].includes(host)) { console.error('usage: register-hooks.mjs --host claude|codex [--dry-run]'); process.exit(2); }
  console.log(JSON.stringify(register(host, { dryRun: args.includes('--dry-run') }), null, 2));
}
