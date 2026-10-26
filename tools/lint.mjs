#!/usr/bin/env node
// Static checks for the rule library: neutrality, budgets, index coverage,
// relative links, cross-file duplicate sentences and byte hygiene.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig, expand, stripFences, charCount } from './lib.mjs';

export function lint(root = ROOT) {
  const cfg = loadConfig(root).lint;
  const errors = [];
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const neutral = cfg.neutralFiles.flatMap((p) => expand(root, p));
  const allMd = listMarkdown(root);

  // Byte hygiene for every markdown file in the library.
  for (const rel of allMd) {
    const buf = fs.readFileSync(path.join(root, rel));
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) errors.push(`${rel}: has BOM`);
    if (buf.includes(0x0d)) errors.push(`${rel}: contains CR`);
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').compare(buf) !== 0) errors.push(`${rel}: invalid UTF-8`);
    if (!s.endsWith('\n') || s.endsWith('\n\n')) errors.push(`${rel}: must end with exactly one newline`);
  }

  // Neutrality: vendor-specific terms outside profiles/ and docs/.
  for (const rel of neutral) {
    const prose = stripFences(read(rel));
    const allowed = (cfg.allow[rel] || []).map((p) => new RegExp(p, 'i'));
    for (const pat of cfg.deny) {
      if (allowed.some((a) => a.source === new RegExp(pat, 'i').source)) continue;
      const m = prose.match(new RegExp(pat, 'i'));
      if (m) errors.push(`${rel}: tool-specific term "${m[0]}" (pattern ${pat})`);
    }
  }

  // Budgets.
  const b = cfg.budgets;
  let onDemand = 0;
  for (const rel of neutral) {
    const n = charCount(read(rel));
    if (rel !== 'core.md') onDemand += n;
    const limit = b[rel] ?? (rel.startsWith('rules/') ? b['rules/*.md'] : undefined);
    if (limit !== undefined && n > limit) errors.push(`${rel}: ${n} chars exceeds budget ${limit}`);
  }
  if (onDemand > b.onDemandTotal) errors.push(`on-demand total ${onDemand} chars exceeds ${b.onDemandTotal}`);

  // Every rule is routed from INDEX exactly once.
  const index = read('INDEX.md');
  const routeTable = index.split('## Routing table')[1]?.split('\n## ')[0] ?? '';
  for (const rel of expand(root, 'rules/*.md')) {
    const count = routeTable.split('`' + rel + '`').length - 1;
    if (count !== 1) errors.push(`INDEX.md: ${rel} appears ${count} times in the routing table (expected 1)`);
  }

  // Relative references like `rules/x.md` or `x.md` must resolve.
  for (const rel of neutral.concat(expand(root, 'profiles/*.md'))) {
    const text = read(rel);
    for (const m of text.matchAll(/`((?:rules|profiles|docs|agents)\/[^`\s]+|[a-z-]+\.md)`/g)) {
      const ref = m[1];
      if (/^(AGENTS|CLAUDE|SKILL|projectBrief|activeContext|systemPatterns|progress)\.md$/i.test(ref)) continue;
      const candidates = [path.join(root, ref), path.join(root, 'rules', ref), path.join(root, path.dirname(rel), ref)];
      if (!candidates.some((c) => fs.existsSync(c))) errors.push(`${rel}: unresolved reference ${ref}`);
    }
  }

  // Duplicate sentences across files (single source of truth).
  const seen = new Map();
  for (const rel of neutral) {
    for (const sentence of sentences(stripFences(read(rel)), cfg.duplicateMinChars)) {
      const prev = seen.get(sentence);
      if (prev && prev !== rel) errors.push(`duplicate sentence in ${prev} and ${rel}: "${sentence.slice(0, 40)}…"`);
      else seen.set(sentence, rel);
    }
  }
  return { errors, onDemand };
}

function sentences(text, min) {
  return text
    .split(/[。；！？\n]|[.;!?](?=\s|$)/)
    .map((s) => s.replace(/[\s`*|>\-#：:，,、"“”（）()]/g, ''))
    .filter((s) => [...s].length >= min);
}

function listMarkdown(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.md')) out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors, onDemand } = lint();
  if (errors.length) {
    for (const e of errors) console.error('✗ ' + e);
    console.error(`${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(`lint ok (on-demand ${onDemand} chars)`);
}
