# Choosing a model and effort level per task: the method

Data as of 2026-10 (Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5). The numbers go stale with the next release; the method does not. The role table in `profiles/claude-code.md` is the output of this page.

## Why not "use the strongest model"

- The effort level is not a minor setting: on agentic benchmarks the gap between one model's low and max is often larger than the gap between models.
- Same-named benchmarks change versions; compare only points from the same chart under the same conditions.
- A small lead inside the noise is a tie.
- What matters is the cost of an acceptable result, not the price per token: a cheap setting that fails and needs rework costs more.

So the question per task is: at a given cost, which model × effort combination scores highest on the closest public benchmark?

## Four inputs per task

| Input | Question | Values |
| --- | --- | --- |
| Capability domain D | What kind of work is it most like? | D1–D10 below |
| Steps and duration H | How many steps, how long? | H1 a few; H2 dozens; H3 hundreds or 30+ minutes |
| Judgment J | Is there a right answer? | J1 yes; J2 criteria but trade-offs; J3 open, value-laden |
| Cost of error R | Is a mistake caught and undone automatically? | R1 auto-checkable; R2 needs a human; R3 hard to undo or used externally |

They combine into a task grade: T0 mechanical (H1+J1+R1), T1 clear, T2 routine judgment, T3 important (any of H3, J3, R3), T4 critical (two or more of them).

Each domain gets the closest public benchmark as a proxy, with its noise: terminal and multi-step engineering (Terminal-Bench 4.0, CursorBench), merge-ready code changes (FrontierCode), knowledge-work deliverables (GDPval-AA, Elo with published confidence intervals), long office projects (AA-Briefcase), deep research (WANDR), cross-app business flows (AutomationBench), computer and browser use (OSWorld 2.1), hard reasoning (Humanity's Last Exam), chart reading (Chartography). Simple Q&A and rewriting have no good proxy and lean on vendor guidance.

## Reading rules

1. Only compare points from one chart under one set of conditions; vendors' cost bases differ between pages.
2. Gaps inside the noise are ties: about 6 points on Terminal-Bench 4.0, 50 Elo on GDPval-AA. Different effort levels of one model on one test set are paired comparisons, so these thresholds are conservative.
3. Convert Elo gaps into a win probability: +50 ≈ 57%, +100 ≈ 64%, +200 ≈ 76%, +350 ≈ 88%.
4. Cost = list price × actual tokens. Subscription quota is assumed to track API cost; this is unverified and gets calibrated locally.
5. Keep vendor-reported and independently re-run numbers apart. For GDPval-AA the two agree within about 20 Elo.

## Where the numbers came from

The vendor launch pages plot score against cost per task as SVG charts. Each point was converted from axis ticks (linear score axis, logarithmic cost axis) in a browser, then checked against every number the page also printed in text or tables: all agreed within 0.2 points or 2 Elo (for example Terminal-Bench 4.0, Opus 5.5 xhigh: 66.5 read from the chart, 66.4 in the table).

## Decision rule

1. Fix the domain and the grade; split a task that spans domains (search apart from synthesis).
2. Keep only points on that domain's cost–score frontier (nothing else is cheaper and at least as good).
3. T0–T1: the first frontier point that is good enough; for auto-checkable work, try cheap and escalate on failure (the vendor measured low-then-high retries at about 97% pass for 0.17 USD per task, against 95.3% for 0.29 USD with high throughout). T2: the cheapest point within two noise widths of the best. T3: the best point, unless the next step up is inside the noise at double the cost. T4: the best point, and on a stall a different model, so that errors are independent.
4. Dependent chains stay in the main session; parallel, read-heavy parts go to subagents on cheap frontier points; the main session checks their conclusions.
5. Calibrate locally: three clean passes in a row one level lower means drop a level; rework means go up.

## What the data said (2026-10)

1. Opus 5.5 at low collapses on agentic work: from low to medium, +19 points on Terminal-Bench, +351 Elo on GDPval-AA (about 88% win rate). Low is for quick back-and-forth only.
2. Medium to high: small coding gains inside the noise, but +121 Elo on deliverables (about 67%) for 1.3–1.8× the cost. High is the default for the main session.
3. High to xhigh pays off for deliverables and deep research (+130 Elo), not for coding (inside the noise), at 2–2.7× the cost. Xhigh to max pays off only for cross-app business flows.
4. Merge-ready code changes peak at Opus 5.5 medium (54.6 on FrontierCode, the best score on the chart); higher effort does not help, and Sonnet 5.5 at max drops to 46.2 by changing things outside the task.
5. Sonnet 5.5 depends heavily on effort, and its medium is weak (28.9 → 61.4 on Terminal-Bench from medium to xhigh). Between about 1 and 4 USD per task, Opus 5.5 dominates it on coding and deliverables.
6. Haiku 5.5 is very cheap for reading, deliverable clean-up and browser steps: at max it ties Opus 5.5 medium on GDPval-AA at the same cost, and at xhigh it reaches 67.6 on OSWorld for 0.28 USD. It is weak at terminal coding.

## Resulting roles

Of these, `agents/` publishes scout, implementer and reviewer as examples.

| Role | Model · effort | Why |
| --- | --- | --- |
| main session | Opus 5.5 · high | finding 2 |
| implementer | Opus 5.5 · medium (Sonnet 5.5 · high to save quota) | finding 4 |
| web-researcher | Haiku 5.5 · high | +143 Elo over medium for about 0.06 USD more per task |
| scout, runner | Haiku 5.5 · medium | clear acceptance criteria |
| browser-operator | Haiku 5.5 · xhigh | 53.3 → 67.6 on OSWorld from medium |
| reviewer / reviewer-deep | Opus 5.5 · high / xhigh | finding 3; a brief cannot change a subagent's effort, hence two definitions |
| verdict | Opus 5.5 · xhigh | best frontier point for deliverables |

## Limits

- Benchmark tasks are not your tasks: this uses relative order and the shape of the cost curves, not absolute success rates.
- Writing in other languages, creative work and interpersonal communication have no good public benchmark.
- Most points are vendor-reported.
- Assumptions still to calibrate locally: quota ∝ API cost; benchmark order transfers to one's own work (track rework); subagents keep the effort in their own definition (check the transcript's `effort` and `model` fields).

## Sources

- [Introducing Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5) — S · vendor launch page (own product) · within 2 months · opened (chart points converted)
- [Introducing Claude Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5) — S · vendor launch page (own product) · within 2 months · opened (chart points converted)
- [Introducing Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5) — S · vendor launch page (own product) · within 2 months · opened (chart points converted)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) — S · official docs · within 2 months · opened
- [GDPval-AA leaderboard](https://artificialanalysis.ai/evaluations/gdpval-aa) — S · benchmark owner · within 2 months · page summary
- [Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0) — S · benchmark owner · page summary
