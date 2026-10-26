# Completion claims

Intent: one card decides what may be called implemented, fixed, verified or deliverable.

- A plan, a code read, history or a started tool is not completion.
- States: `implemented_unverified` (written, no current check), `partial` (some scope has current evidence), `verified_current` (the current candidate passed checks that match the risk), `blocked` (missing access, environment or facts). `interrupted`, `timeout`, `no_output` and `cancelled` are run states, never "passed".
- Evidence names the candidate (file hash or commit), the command actually run, the environment, the exit status, key observations and what was not covered.
- A green result is reused only when content, dependencies, environment and command are all unchanged. A check counts only if it ran after the last change to the files it covers; otherwise write "passed before the last change, not re-run".
- Start with the narrowest check that could falsify the claim, then widen with the risk.
- Rule, prompt and config changes are checked against their contract (parse, schema, references, a fresh session); reading the diff does not prove a rule took effect.
- A change of about 500+ lines or 3+ modules gets a review of the diff alone in a fresh context before it is called done; each finding gets a failing test before its fix.
- When the user says they will accept a step themselves, do not accept it for them, and still list what was not verified.

Enforced by: the Stop hook `stopStaleVerification` blocks a pass claim when files changed after the last run of that check in the turn; `stopIndependentReview` reminds once after a large unreviewed change.
