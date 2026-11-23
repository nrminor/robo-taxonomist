---
name: keep-wire-expectations-independent
subject: Tests of serialized payloads or malformed boundary inputs
requirement: Write expected wire values and malformed inputs independently of
  the production codec or constructor under test. Assert literal tags and field
  absence when they are part of the contract; otherwise check the behavior the
  test is meant to protect. Keep invalid values in a representation that
  preserves the failure being tested.
purpose: Catch contract regressions without letting the implementation generate
  its own expected result or silently changing the negative case.
---
Use hand-written JSON for an exact JSON response. Keep a nonfinite number as a JavaScript value when testing rejection of Infinity; JSON serialization would turn it into null.