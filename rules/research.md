# Research

Intent: answer with the fewest, strongest sources, and say what is missing.

1. Local questions: local files, code and git history.
2. A known public URL: read it directly; use a browser only when the page needs rendering or interaction.
3. Unknown pages: the host's web search, starting with one query aimed at the gap; add a second, different query only while a gap that would change the answer remains.
4. Vendor facts: the vendor's docs. A known repo, issue or release: the code host's CLI or API. One fallback at most, never a cascade across providers.
5. Platform-native search only for platforms general search cannot reach, and only the platform in question.

- The configured banned tool is never used, including as a fallback.
- Stop as soon as direct, high-grade evidence answers the question. Under an explicit "deep research" request, widen one query at a time; the fifth distinct query is a checkpoint for scope and yield, not a quota.
- Equivalent queries count once. A search snippet is a lead and cannot carry a core conclusion alone.
- Unreachable, conflicting or over-budget evidence is marked `evidence_gap`, with its effect on the conclusion.

Enforced by: the PreToolUse `bannedTool` check denies any call to the banned tool, its API host or its SDK; researching the tool by name stays allowed.
