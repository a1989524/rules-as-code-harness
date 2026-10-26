#!/usr/bin/env node
// Offline replay of real Claude sessions against the hooks. No model calls, no network.
//   node evals/replay.mjs extract [--since 2026-09-20] [--projects <dir>]
//       Pull deduplicated user prompts and their tool calls into .state/replay/turns.jsonl (gitignored).
//       Prompts and commands are truncated and secret-like strings are replaced with <redacted>.
//   node evals/replay.mjs keywords
//       Which prompts get the fast-domain / reuse notes, per keyword, with short samples to review.
//   node evals/replay.mjs gate --session <id prefix> --at <ISO time> [--projects <dir>]
//       Rebuild the transcript as it was at <at> and run the pre-tool gate on the next tool call.
//   node evals/replay.mjs stop --session <id prefix> --at <ISO time> [--projects <dir>]
//       Rebuild the transcript up to <at> and run the Stop hook on the last answer before it.
//   node evals/replay.mjs analysis [--since 2026-10-02] [--sample 30]
//       Requirement-analysis observation: prompt kinds over the corpus with a sample to review by hand,
//       and a summary of what the hooks logged since <since> (tiers, questions, write-before-tier, rework).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../tools/lib.mjs';
import { loadHookConfig, classifyPrompt } from '../hooks/lib.mjs';
import { matchesAny } from '../hooks/prompt-context.mjs';
import { decide } from '../hooks/pre-tool-gate.mjs';

const OUT = path.join(ROOT, '.state', 'replay', 'turns.jsonl');
const SKIP_PROJECT = /sandbox|[-\\/]eval($|[-\\/])/i;

// Secret-like strings: known token prefixes, bearer and key=value pairs, long mixed letter+digit runs.
const SECRETS = [
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;]{6,}/gi,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
];
export function redact(s) {
  let t = String(s ?? '');
  for (const re of SECRETS) t = t.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) && keep !== m ? keep : '') + '<redacted>');
  return t;
}

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const projectsDir = () => arg('projects', path.join(os.homedir(), '.claude', 'projects'));
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
const isPrompt = (o, t) => o.type === 'user' && !o.isMeta && !o.isSidechain && !o.isCompactSummary && t
  && !/^\s*<(local-command|system-reminder|task-notification|command-)/.test(t) && !/^Base directory for this skill/.test(t);

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (fn(o, line) === false) { rl.close(); break; }
  }
}

function transcripts(since) {
  const dir = projectsDir(); const out = [];
  for (const p of fs.readdirSync(dir)) {
    const pd = path.join(dir, p);
    if (SKIP_PROJECT.test(p) || !fs.statSync(pd).isDirectory()) continue;
    for (const f of fs.readdirSync(pd)) {
      const fp = path.join(pd, f);
      if (f.endsWith('.jsonl') && fs.statSync(fp).mtime >= since) out.push({ project: p, file: fp });
    }
  }
  return out;
}

async function extract() {
  const since = new Date(arg('since', new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)));
  const seenPrompt = new Set(); const seenCall = new Set(); const turns = [];
  for (const { project, file } of transcripts(since)) {
    let cur = null;
    await eachLine(file, (o) => {
      if (o.type === 'user') {
        const t = textOf(o.message && o.message.content);
        if (!isPrompt(o, t)) return;
        if (seenPrompt.has(o.uuid)) { cur = null; return; } // copied history of a resumed session
        seenPrompt.add(o.uuid);
        cur = { session: path.basename(file, '.jsonl'), project, ts: o.timestamp, promptId: o.uuid, prompt: redact(t.replace(/\s+/g, ' ').slice(0, 800)), calls: [] };
        turns.push(cur);
      } else if (o.type === 'assistant' && !o.isSidechain && cur) {
        for (const b of (o.message && o.message.content) || []) {
          if (!b || b.type !== 'tool_use' || seenCall.has(b.id)) continue;
          seenCall.add(b.id);
          const i = b.input || {}; const c = { name: b.name, ts: o.timestamp };
          for (const k of ['command', 'file_path', 'url', 'query', 'path', 'pattern', 'skill']) if (typeof i[k] === 'string') c[k] = redact(i[k].slice(0, 400));
          cur.calls.push(c);
        }
      }
    });
  }
  turns.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
  console.log(JSON.stringify({ turns: turns.length, calls: turns.reduce((n, t) => n + t.calls.length, 0), out: path.relative(ROOT, OUT) }));
}

function keywords() {
  const cfg = loadHookConfig();
  const turns = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const report = (list) => {
    const per = {}; let hit = 0;
    for (const t of turns) {
      const matched = (list || []).filter((k) => matchesAny(t.prompt, [k]));
      if (matched.length) hit += 1;
      for (const k of matched) (per[k] ||= []).push(t.prompt.slice(0, 50));
    }
    return { prompts: turns.length, withNote: hit, perKeyword: Object.fromEntries(Object.entries(per).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, { count: v.length, samples: v.slice(0, 3) }])) };
  };
  console.log(JSON.stringify({ fastDomain: report(cfg.fastDomainKeywords), reuse: report(cfg.reusePromptKeywords) }, null, 1));
}

async function gate() {
  const prefix = arg('session'); const at = arg('at');
  if (!prefix || !at) throw new Error('gate needs --session and --at');
  const found = transcripts(new Date(0)).find((t) => path.basename(t.file).startsWith(prefix));
  if (!found) throw new Error(`no transcript starting with ${prefix}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-gate-'));
  const partial = path.join(tmp, 'transcript.jsonl');
  const out = fs.createWriteStream(partial);
  let next = null;
  const cutoff = new Date(at).getTime();
  if (Number.isNaN(cutoff)) throw new Error(`--at is not a time: ${at}`);
  await eachLine(found.file, (o, line) => {
    if (o.timestamp && new Date(o.timestamp).getTime() >= cutoff && o.type === 'assistant') {
      next = ((o.message && o.message.content) || []).find((b) => b && b.type === 'tool_use') ? o : null;
      if (next) return false;
    }
    out.write(line + '\n');
  });
  await new Promise((r) => out.end(r));
  if (!next) throw new Error(`no tool call at or after ${at}`);
  const use = next.message.content.find((b) => b.type === 'tool_use');
  const input = { session_id: `replay-${prefix}`, tool_name: use.name, tool_input: use.input, transcript_path: partial, cwd: next.cwd };
  const result = decide(input, { cfg: loadHookConfig(), dir: path.join(tmp, 'state'), host: 'claude' });
  console.log(JSON.stringify({ at: next.timestamp, tool: use.name, command: redact(String((use.input && use.input.command) || '').slice(0, 160)), bytes: fs.statSync(partial).size, result }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Rebuild the transcript up to <at> and run the Stop hook on the last assistant answer before it.
async function stopAt() {
  const prefix = arg('session'); const at = arg('at');
  if (!prefix || !at) throw new Error('stop needs --session and --at');
  const found = transcripts(new Date(0)).find((t) => path.basename(t.file).startsWith(prefix));
  if (!found) throw new Error(`no transcript starting with ${prefix}`);
  const cutoff = new Date(at).getTime();
  if (Number.isNaN(cutoff)) throw new Error(`--at is not a time: ${at}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-stop-'));
  const partial = path.join(tmp, 'transcript.jsonl');
  const out = fs.createWriteStream(partial);
  let answer = null; let cwd = null;
  await eachLine(found.file, (o, line) => {
    if (o.timestamp && new Date(o.timestamp).getTime() > cutoff) return false;
    out.write(line + '\n');
    if (o.cwd) cwd = o.cwd;
    if (o.type === 'assistant' && !o.isSidechain) { const t = textOf(o.message && o.message.content); if (t.trim()) answer = t; }
  });
  await new Promise((r) => out.end(r));
  if (!answer) throw new Error(`no assistant answer before ${at}`);
  const { run } = await import('../hooks/closing-check.mjs');
  const result = await run({ session_id: `replay-${prefix}`, transcript_path: partial, cwd, last_assistant_message: answer }, { cfg: loadHookConfig(), dir: path.join(tmp, 'state'), host: 'claude' });
  const log = fs.readFileSync(path.join(tmp, 'state', 'hook-log.jsonl'), 'utf8').trim().split('\n').pop();
  const { stale, review } = JSON.parse(log);
  console.log(JSON.stringify({ answerHead: redact(answer.slice(0, 80)), stale, review, decision: result && (result.decision || 'message'), reason: result && redact(String(result.reason || result.systemMessage).slice(0, 400)) }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
}

function analysis() {
  const cfg = loadHookConfig();
  const turns = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const real = turns.filter((t) => t.prompt.length >= 2 && !/^<|^\[Request interrupted|^The app was quit/.test(t.prompt));
  const kinds = {}; let rework = 0;
  const rows = real.map((t) => { const c = classifyPrompt(t.prompt, cfg); kinds[c.kind] = (kinds[c.kind] || 0) + 1; if (c.rework) rework += 1; return { kind: c.kind, rework: c.rework, prompt: t.prompt.slice(0, 60) }; });
  const n = Number(arg('sample', 30));
  const step = Math.max(1, Math.floor(rows.length / n));
  const sample = rows.filter((_, i) => i % step === 0).slice(0, n);
  // Hook log since <since>: what the observation period recorded.
  const since = arg('since', '2026-10-02');
  const logFile = path.join(ROOT, '.state', 'hook-log.jsonl');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && String(o.ts) >= since) : [];
  const tally = (xs) => xs.reduce((m, x) => ((m[x ?? 'none'] = (m[x ?? 'none'] || 0) + 1), m), {});
  const stops = log.filter((o) => o.event === 'Stop' && o.analysis);
  const prompts = log.filter((o) => o.event === 'UserPromptSubmit' && o.kind);
  const summary = {
    prompts: prompts.length, promptKinds: tally(prompts.map((o) => o.kind)), reworkPrompts: prompts.filter((o) => o.rework).length,
    stops: stops.length, tiers: tally(stops.map((o) => o.analysis.tier)),
    implementStopsWithoutTier: stops.filter((o) => o.analysis.kind === 'implement' && !o.analysis.tier).length,
    avgQuestions: stops.length ? +(stops.reduce((s, o) => s + (o.analysis.questions || 0), 0) / stops.length).toFixed(2) : 0,
    writeBeforeTier: log.filter((o) => o.event === 'PreToolUse' && o.check === 'analysisGate').length,
  };
  console.log(JSON.stringify({ corpus: { prompts: real.length, kinds, rework }, sample, observation: { since, ...summary } }, null, 1));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  const run = { extract, keywords, gate, stop: stopAt, analysis }[cmd];
  if (!run) { console.error('usage: node evals/replay.mjs extract|keywords|gate|stop|analysis [options]'); process.exit(2); }
  Promise.resolve(run()).catch((err) => { console.error(String(err.message || err)); process.exit(1); });
}
