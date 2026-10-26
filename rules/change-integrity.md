# Change integrity

Intent: changes to user-level config, global rules, other projects or remote systems are backed up, verified and reversible, file by file.

- The candidate is the ordered set of files the user's consent covers; nothing is inferred from neighbouring files.
- Per file: canonical path, original SHA-256 and size, intended change, write method, check, rollback source.
- Back up every original before the first write and verify each backup's hash; a failed backup stops the change.
- After writing: hash, strict UTF-8, BOM, line endings, syntax, schema and references. For rules and prompts, behaviour in a fresh session is the only proof of effect.
- Rollback restores only the files this change touched, from the exact backup, and checks the original hash again. A missing backup or a hash mismatch stops the restore (`ROLLBACK_PREIMAGE_UNAVAILABLE`).
- Preparing a candidate is not consent to install, publish or distribute it.

Implemented by: `tools/sync.mjs` and `tools/register-hooks.mjs` validate every target before writing any, back up with a SHA-256 manifest, and restore with drift detection.
