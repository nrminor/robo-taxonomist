---
name: start-with-supported-tooling
subject: Repository-specific wrappers around third-party development tools
requirement: Start with the upstream documented setup. Add a wrapper only when
  it serves a concrete requirement the supported interfaces cannot meet cleanly
  and that requirement justifies the maintenance cost. Prefer public entry
  points; make any reliance on internals explicit before adopting it.
purpose: Avoid maintaining tool integrations that do not earn their complexity.
---
