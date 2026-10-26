# Testing strategy

- Pick tests by risk (severity, likelihood, detection gap, recoverability, user impact) and map each risk to the narrowest test layer with a clear oracle.
- Bug fixes, rules, parsers, public APIs, security boundaries and migrations go test-first: record a failing test before the fix. Legacy behaviour gets a characterization test first.
- The default scope is the target tests plus their closure; unrelated failures are reported apart.
- A mock names the boundary it replaces; passing against mocks does not prove the real integration.
- Skipped is not passed. Regression tests for real bugs stay.

Enforced by: the rule gate before test commands.
