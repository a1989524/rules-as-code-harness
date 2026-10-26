// Shared helpers for sync, lint and tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'adapters.json'), 'utf8'));
}

// "~/x" in the config means the user's home directory.
export const expandHome = (p, home = os.homedir()) => String(p).replace(/^~(?=[\\/]|$)/, home);

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Normalize to LF, no BOM, exactly one trailing newline.
export function normalize(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
}

export const charCount = (text) => [...text].length;

// Expand "rules/*.md" style patterns relative to root (single-level glob only).
export function expand(root, pattern) {
  if (!pattern.includes('*')) return fs.existsSync(path.join(root, pattern)) ? [pattern] : [];
  const dir = path.posix.dirname(pattern);
  const re = new RegExp('^' + path.posix.basename(pattern).replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`);
}

// Remove fenced code blocks so prose checks ignore code samples.
export function stripFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}
