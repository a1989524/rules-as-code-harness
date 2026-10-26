# Git hygiene

- A dirty tree is context, not a blocker: never stash, commit, reset, check out or clean on your own.
- Never clean, revert, move, overwrite or commit the user's changes without consent; when undoing, undo only what this task did.
- Creating or deleting worktrees, merging, pushing, opening pull requests, pruning and cleaning need explicit consent.
- Before suggesting an isolated worktree, find out what the current root is: a plain or linked worktree, a submodule, a detached HEAD, or not git at all.

Enforced by: the rule gate before git commands; `dangerousCommands` asks before force pushes, hard resets, cleans and publishes.
