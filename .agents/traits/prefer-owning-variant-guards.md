---
name: prefer-owning-variant-guards
subject: Checks, assertions, and branches on tagged Effect domain values
requirement: Use the owning schema's case guard or matcher when it is available.
  Otherwise use Effect Predicate.isTagged for a single case or Match for case
  dispatch. Avoid reading the discriminant directly to check or branch on a
  domain variant.
applicability: Code that works with domain values; not tests whose contract is
  the literal serialized discriminant field.
purpose: Keep variant checks tied to their domain definition and preserve type
  narrowing without hand-written discriminant comparisons.
---
Use `expect(result).toSatisfy(IdLookup.guards.NotFound)` rather than `expect(result._tag).toBe("NotFound")`.