---
name: name-effect-schema-field-types
subject: Type derivation for fields in Effect schema-backed models
requirement: Derive types from named Effect schemas or Effect utilities, not
  string-literal indexed access types such as Model["field"]. Name the component
  schema and derive its type directly with typeof SchemaName.Type or typeof
  SchemaName.Encoded. Use the owning Effect schema or Effect branding utility
  when nominal identity is needed.
purpose: Keep field types, runtime validation, and nominal identity tied to
  explicit Effect definitions instead of type-level projections.
---
