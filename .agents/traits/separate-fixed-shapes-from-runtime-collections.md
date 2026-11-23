---
name: separate-fixed-shapes-from-runtime-collections
subject: Data modeling in Effect TypeScript
requirement: Model fixed shapes with named TypeScript types or Effect schemas.
  Use Effect collections such as HashMap, HashSet, or arrays for data whose keys
  or membership are determined at runtime. Do not use open object records as
  collections, use Object or Record APIs to model data, or manipulate prototypes.
  If an external protocol requires keyed JSON, keep that representation at the
  adapter boundary; do not carry it into the domain model.
purpose: Keep fixed fields and dynamic collection operations distinct so that
  runtime keys do not erase the guarantees of TypeScript or Effect schemas.
---
