# Prefer executable rules

`AGENTS.md` files usually do more harm than good. They create a second, fuzzier rule surface that repeats what the code says and then drifts from it. Treat this file as an exception, not a handbook. Keep rules in code, configuration, and tests; put the fix in the diagnostic. Use this file only for decisions executable checks cannot make, such as who can approve an exception. Do not add another `AGENTS.md` unless the maintainer agrees there is a specific need the code cannot express.

Propose a new rule or strengthen an existing rule when a recurring mistake can be detected reliably. Show a real example, and test both the mistake and the legitimate alternative. Check for equivalent Oxlint and Effect rules before adding a local implementation.

Discuss and obtain explicit maintainer approval **before** adding any exception or weakening or removing a rule. This includes inline suppressions, allowlists, narrower scopes, new ignores, severity changes, and replacement with a weaker check. A comment records an approved exception; it does not grant approval. For a removal, identify what will no longer be enforced or show that the replacement preserves the behavior. Until approved, keep enforcement in place and report the finding.
