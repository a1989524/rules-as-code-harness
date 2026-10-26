# Requirement analysis

Intent: decide what to build, whether it is worth building and how, before touching files.

Open each answer with `Tier: <tier> | Why: <one line>`. When unsure, take the heavier tier; tiers only move up.

| Tier | When | Then |
| --- | --- | --- |
| direct | one line, reversible, no ambiguity that changes the result | restate in one line and do it |
| brief | a scoped local change with one or two open points | 5–10 lines of restatement, judgment and advice; stop and wait |
| full analysis | new project or feature, cross-module, costs money, public release, irreversible, or advice that departs from the request | every item below; stop and wait |
| design first | visual, motion or complex interaction work | agree a direction, build 2–3 clearly different quick demos, merge after the user picks |
| probe | "can this work", "how well does it work" | the cheapest one-off check; probe code never merges |
| research | research, reports, writing | restate the question, reader and scope; ask only what changes the scope |

- A full analysis covers: what was said versus inferred, whether the problem is real, existing solutions, feasibility, cost, options with their worst cases, a recommendation with its conditions, the first thin slice, and the assumptions that would change it.
- Ask when two or three plausible readings would give clearly different results; otherwise pick one and state the assumption. Questions have no cap; split them into "must answer" and "default is fine", each with options and a recommended answer.
- An approval covers only the step that was shown.

Enforced by: UserPromptSubmit adds a tiering reminder to implementation requests; PreToolUse `analysisGate` logs a project write made before the tier line (observation mode, deny when switched to enforce).
