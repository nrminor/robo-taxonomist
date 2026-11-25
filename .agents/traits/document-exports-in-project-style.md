---
name: document-exports-in-project-style
subject: JSDoc for exported symbols
requirement: Every exported symbol must have a JSDoc docstring at its
  declaration or re-export. Explain what callers need to know in simple technical
  English. Follow comparable project docstrings for JSDoc tags and their order,
  including `@since`, `@category`, and `@example` where the project uses them.
  Preserve the original introduction version when moving an existing export.
  Use supported imports and realistic calls in examples. Before handing off
  new or changed export documentation, have a separate agent compare it with
  nearby docstrings and review the prose, tags, and examples. Self-review does
  not count.
purpose: Help readers understand what each export does and how to use it without
  having to read its implementation.
---
