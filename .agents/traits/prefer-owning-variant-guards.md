---
name: prefer-owning-variant-guards
subject: Checks, assertions, branches, and failure handling in Effect TypeScript
requirement: Use the owning schema's case guard or matcher when it is available.
  Otherwise use Effect Predicate.isTagged for a single case or Match for case
  dispatch. Avoid reading the discriminant directly to check or branch on a
  domain variant. Use Effect guards and matching instead of repeated manual
  checks. Use Option-producing lookups and Option composition for expected
  absence rather than imperative undefined checks. Use an owning schema or
  Effect error constructor for failures and defects rather than constructing a
  generic Error as a fallback. Apply these standards to code sketches as well as
  implementation.
applicability: Code and sketches that work with domain values or Effect flows.
  The discriminant guidance does not apply to tests whose contract is the
  literal serialized discriminant field.
purpose: Keep variant checks tied to their domain definition and preserve type
  narrowing without hand-written discriminant comparisons. Make absence, typed
  failures, and defects explicit.
---
Use `expect(result).toSatisfy(IdLookup.guards.NotFound)` rather than `expect(result._tag).toBe("NotFound")`.