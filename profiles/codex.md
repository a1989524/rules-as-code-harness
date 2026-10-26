# Codex profile

Maps the neutral wording of the cards to Codex.

| Card wording | In Codex |
| --- | --- |
| the host's web search and page reading | the built-in web search |
| native file editing | apply_patch |
| command execution | the shell tool, under Codex's sandbox and approval policy |
| subagents | spawn_agent with a custom role from ~/.codex/agents/, generated from `agents/codex/`; pass `fork_turns: "none"` so the role's model applies |

## Hooks

`node tools/register-hooks.mjs --host codex` writes ~/.codex/hooks.json with the same scripts. Differences from Claude Code:

- PreToolUse supports deny only: dangerous commands are logged and left to Codex's approval policy.
- The checks that parse the Claude transcript format (rule coverage, source labels, stale checks, review reminders) do not run; the line counter and the tier injection, which reads Codex's own rollout format, do. The closing-section check is switched off on both hosts.

## Entry file

`tools/sync.mjs` writes ~/.codex/AGENTS.md as one concatenated file (target mode `copy`), within an 80 KB budget checked on every sync.
