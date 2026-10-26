# Update logs

- Required when: the user or the project asks; the task reaches 700 changed lines (added plus deleted, across the whole task); it touches auth, permissions, a public API, a schema or data migration, dependencies, deployment, routing or persisted state; it restructures across modules; or it pauses or hands off with work still open.
- Count from a recorded baseline. The user's own earlier edits, lockfiles, generated files and docs do not count. Once triggered, it stays triggered.
- One log per work package, in the project's log directory or `update logs/`: goal, trigger, baseline, files, changes, commands and results, gaps, risks, rollback, hand-off.
- No secrets in logs. A log is the entry point to the evidence, not the completion verdict.

Enforced by: the rule gate before the first project write; the Stop hook counts changed lines against the session baseline and reminds at 700 when no log was touched.
