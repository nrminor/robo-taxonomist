---
name: provide-one-check-entry-point
subject: How a repository defines and runs verification
requirement: Provide one documented command that runs the full verification
  suite for both people and agents. Keep individual checks callable for
  diagnosis, but do not make callers assemble the suite themselves. Use existing
  project task recipes for checks, builds, tests, and packaging rather than
  reconstructing those commands. Use Mise tasks when the repository defines
  them.
purpose: Make complete verification easy to run, keep the expected checks from
  drifting, and honor the project's pinned tools and options.
---
