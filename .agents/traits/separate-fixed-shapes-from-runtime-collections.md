---
name: separate-fixed-shapes-from-runtime-collections
subject: Data modeling in Effect TypeScript
requirement: Model fields known at compile time with named TypeScript types or
  Effect schemas. When keys or membership are determined at runtime, use Effect
  collections such as HashMap for lookup, HashSet for membership, or arrays for
  ordered entries. Use a fixed schema to validate each entry's shape, not to
  turn the runtime keys into struct fields. Do not use Struct.assign or other
  shape utilities to implement runtime collection operations. Do not use open
  object records as collections, use Object or Record APIs to model data, or
  manipulate prototypes. If a wire protocol or library interface requires keyed
  data, convert at that adapter boundary; do not use the keyed representation
  for lookups or membership checks in the domain model.
purpose: Keep fixed fields and dynamic collection operations distinct so that
  runtime keys do not erase the guarantees of TypeScript or Effect schemas.
---
For a batch response, validate each answer with its own schema, store the answers in a `HashMap`, and compare the submitted and received IDs with `HashSet`s. Do not construct a struct schema with one field per submitted ID. If the provider interface requires keyed output, convert the validated entries only when returning to that interface.
