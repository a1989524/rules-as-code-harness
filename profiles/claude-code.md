# Claude Code profile

Maps the neutral wording of the cards to Claude Code. The cards stay tool-neutral; this file does not.

| Card wording | In Claude Code |
| --- | --- |
| the host's web search and page reading | WebSearch, WebFetch |
| native file editing | Edit and Write (Read first); Grep and Glob to search |
| command execution | Bash or PowerShell |
| subagents | the Agent tool; role definitions in ~/.claude/agents/, generated from `agents/claude/` |

## Hooks

`node tools/register-hooks.mjs --host claude` merges five hooks into ~/.claude/settings.json. Every other key is left byte-identical, and the old file is backed up with a SHA-256 manifest.

- SessionStart records a git baseline for line counting; after compaction it re-injects the core constraints.
- UserPromptSubmit adds the date, the current model tier (from the hook input, or the transcript's last answer) and the fast-domain, reuse and tiering reminders, capped at 600 characters.
- PreToolUse denies calls to the banned tool, sensitive reads and secret egress; asks before dangerous commands; denies once per prompt for an unread scene card, a plan without a reuse search, or a skill script run before the skill was loaded; asks before reads outside the whitelist. Subagents get the safety checks and the whitelist, not the process gates.
- PostToolUse nudges about unread scene cards.
- Stop blocks once for unlabeled sources after a search and for a pass claim made stale by later edits; reminds about large unreviewed changes and the 700-line log; logs the tier line, question count and delegation.

Each check has a switch in adapters.json under hooks.enforce (off, warn, enforce); `AGENT_PROMPTS_HOOKS=off` turns them all off. Deny rules in settings.json (for example reading env files) only cover the built-in tools, so the shell is covered by the hook.

## Model tiers (as of 2026-10)

- verdict: Opus 5.5 · xhigh. main: Opus 5.5 · high. execution: Opus 5.5 · medium, or Sonnet 5.5 · high to save quota. light: Haiku 5.5, high for search, xhigh for the browser, medium for inventory and commands.
- Roles published here: scout (light · medium), implementer (execution), reviewer (main). The private setup also runs a web researcher, a command runner, a browser operator and a deep reviewer at xhigh. Definitions pin full model IDs so a remapped alias cannot change them.
- How the tiers were derived: `docs/model-tier-method.md`.
