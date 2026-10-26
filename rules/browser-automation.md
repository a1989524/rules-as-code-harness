# Browser automation

- Tell public pages, local demos and protected pages apart; a local pass is not evidence for a real logged-in flow.
- Read static pages with the page-reading tool; use a browser for rendering, navigation, interaction or login state.
- Never read raw cookies, tokens or storage. A 401 or 403 is a finding to investigate, not proof of missing credentials. When a login is needed, the user logs in through the site's own interface.
- In a shared browser, open your own tab, act only on it and close only what you opened; never log out, clear site data or change context settings.
- Screenshots, console and network logs are the evidence, with no credentials or private data in them.

Enforced by: the rule gate before the first browser tool call.
