# Reuse first

Intent: before writing something new, find out whether it already exists.

- Applies to a new project, a new feature or capability, or an implementation plan; not to bug fixes or small changes, and not when the user says to skip it.
- Search in order: local projects and installed skills (whitelisted places only); GitHub through its official CLI, for example `gh search repos <keywords> --archived=false --updated=">YYYY-MM-DD"`; package registries and curated lists.
- Assess each candidate: coverage, activity (an AI tool with no commit in two months is inactive), licence (MIT, Apache and BSD are fine; state the impact of GPL or AGPL; no licence means no reuse), security and maintenance (OpenSSF Scorecard when available). Stars are only a lead.
- The plan carries a reuse table: candidate, coverage, licence, activity, risk, verdict (dependency, fork, borrow the design, or not used).
- Research is read-only: no cloning, installing or running a candidate without consent.

Enforced by: PreToolUse `reuseGate` denies the first write of a plan file or of a new project manifest when no real search ran in the recent prompts.
