# Commands and encoding

- Machine-read text is strict UTF-8 without BOM, with LF line endings and exactly one final newline. Prefer native edit tools or a structured API to string concatenation.
- Each command stands alone: no reliance on an earlier `cd`, variable or shell state.
- Child processes get argument arrays, an explicit working directory, a timeout and an output cap; use a shell only when shell semantics are needed.
- Report a probe at the level it actually reached: written, parseable, loadable, active, smoke passed, not run.
- Stop retrying after the same failure signature twice, or three failures at one level, and report the gap.

Enforced by: the rule gate when a shell command writes JSON, Markdown, YAML or similar files.
