# External tools and MCP

- Tools act, resources inform and prompts only advise. A registry entry proves that a capability exists, not that it is available, trusted or allowed.
- Use the smallest set of exposed capabilities that reaches the result; add management tools only when the task is about installing, updating or configuring.
- Installing, updating, syncing, configuring, authenticating and remote writes need consent that covers the target and its side effects.
- On failure, record the layer and the error, pick at most one fallback, and stop with the gap rather than trying every tool in turn. Stop a paid backend on 402, honour Retry-After on 429, retry a 5xx once.

Enforced by: the rule gate before the first call to an MCP tool.
