---
name: name-distinct-computation-steps
subject: Code that performs several distinct steps to compute a value or carry
  out an operation
requirement: "Make the steps read in execution order: left to right through
  fluent transformation chains, or top to bottom through descriptive bindings
  when fluent chaining does not fit. Use binding names to explain what each
  intermediate means, and give distinct stages visual breathing room. Avoid
  nesting distinct steps that a reader must unpack from the inside out or right
  to left."
applicability: Multi-step code. Simple nested calls can stay inline when they
  express one idea and an intermediate name would add no information.
purpose: Make the flow easy to scan and each step self-documenting without
  adding names or whitespace for their own sake.
---
For separate path, I/O, and decoding steps, prefer:

```js
const manifestPath = join(directory, "package.json");
const manifestText = readFileSync(manifestPath, "utf8");

const manifest = decodeManifest(manifestText);
```

For a fluent transformation, keep the input first and list stages in order:

```ts
const normalizedLabel = label.trim().normalize("NFC");
```