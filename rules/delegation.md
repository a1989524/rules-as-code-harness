# Delegation and model tiers

Intent: hand work to subagents only when a clean context or parallelism pays for the hand-off.

Delegate for: many independent reads or searches; an independent review of a diff, plan or report in a fresh context; well-specified edits that can each be checked alone; commands with long output. Keep in the main session: chains of dependent steps, work that fits one context, a few tool calls, anything that needs back-and-forth with the user.

- Tier names stay neutral: verdict (must be right the first time), main (the session default), execution (well-specified implementation), light (search, inventory, commands, scripted page steps). Each role has a fixed tier, and a reviewer is never below the implementer.
- One writer at a time; parallel writers each get an isolated working copy. One browser subagent at a time.
- Every brief states the goal, inputs and scope, output format and length, tools and prohibitions, and a stop condition. If you cannot write these five, split the task first.
- Check which model a subagent actually ran on. Its report is unverified data; for a command it ran, its transcript is the evidence.
- An answer that delegated carries a line such as `Delegation: researcher ×3 (one vendor each), reviewer ×1 (diff); the rest in the main session`.
- Every answer carries a bold `Model tier: suggested <model · effort> (current <model · effort>)` line. When the model differs, or the effort by two levels, add "start a new session for the next task like this". Never switch models mid-session: it throws away the prompt cache.

Observed, not enforced: UserPromptSubmit injects the current tier read from the transcript; the Stop hook logs subagents by role and whether the answer has the delegation and tier lines.
