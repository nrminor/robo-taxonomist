# `robo-taxonomist`

`robo-taxonomist` is a TypeScript library for biologists that provides utilities for resolving ambiguous taxonomic labels with decision models. For example, let's say you have the following taxon labels:

- "Voucher A17 | Quercus robur"
- "Voucher B42 | Fagus sylvatica"

Rather than using inscrutable and nested regex patterns and other techniques to identify whether these two labels are, say, within the same Order, `robo-taxonomist` leverages a decision model to give a clear, scored decision.

`robo-taxonomist` allows you to compare individual taxonomic records, test membership of one taxon within another, and build and compare sets of taxa. Using [Effect v4](https://effect.website/docs/v4/onboarding)'s AI API, it allows you to plug your own decision model of choice, supporting TypeSafe-AI's Jev, Cloudflare's Clef, OpenAI's decision API, and any other API-compatible model.

## Install

```sh
pnpm add robo-taxonomist effect@4.0.0 @effect/ai-typesafe@4.0.0
```

The example uses `@effect/ai-typesafe` as its provider. Replace it with the adapter for your chosen model.

## Example

Below is a complete example application using Effect and `robo-taxonomist`. It compares records, tests membership, and partitions records. As its model, it uses TypeSafe-AI's Jev; set `TYPESAFE_API_KEY` in your environment to try it yourself, or replace the model layer with another `DecisionModel`.

```ts
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RecordLabel, TaxonName, Taxonomy, TaxonSet } from "robo-taxonomist";

// Configure a provider once. Any Effect DecisionModel can fill this role.
const DecisionModelLive = TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
  Layer.provide(TypeSafeClient.layerConfig()), // Reads TYPESAFE_API_KEY.
  Layer.provide(FetchHttpClient.layer),
);

// Define the program as an Effect value
const program = Effect.gen(function* () {
  // Keep the original record text and your application's own fields.
  const oak = { label: RecordLabel.make("Voucher A17 | Quercus robur"), sampleId: "A17" };
  const beech = { label: RecordLabel.make("Voucher B42 | Fagus sylvatica"), sampleId: "B42" };

  // 1. Compare the species described by two records.
  // The answer is a typed judgment, which can include Undetermined.
  const comparison = yield* Taxonomy.sameSpecies(oak, beech);

  // 2. Combine whole taxa into a target, then test a record against it.
  const trees = TaxonSet.union(
    TaxonSet.of(TaxonName.make("Quercus")),
    TaxonSet.of(TaxonName.make("Fagus")),
  );
  // Membership asks whether every subject in this record belongs to the target.
  const membership = yield* Taxonomy.recordBelongsTo(beech, trees);

  // 3. Partition several records against one taxon.
  const partition = yield* Taxonomy.partitionRecordsByMembership(
    [oak, beech],
    TaxonName.make("Quercus"),
  );

  // Buckets retain the original records, including sampleId.
  // Unresolved judgments stay separate so your application can review them.
  return {
    comparison,
    membership,
    memberIds: partition.Member.map((record) => record.sampleId),
    unresolvedIds: partition.Undetermined.map((record) => record.sampleId),
  };
});

// Supply the model at the application boundary and run the complete program.
await Effect.runPromise(program.pipe(Effect.provide(DecisionModelLive), Effect.tap(Effect.log)));
```

## Try the demo

From a checkout of this repository, run `mise run bootstrap`, then `mise run demo:dev`. Open <http://127.0.0.1:3000>.

Choose a panel to see which taxa match each of 24 synthetic records. Select a record to inspect its matches, or compare how much abundance matches each target. A record can match more than one target. The example uses fixed answers and does not call a model provider.

Run `mise run demo:check` to check types, run tests, and build the site. `mise run check` also checks the demo.

UI tests run in Chromium through Vitest's Playwright provider; service and HTTP tests run in Node with Effect. Before running checks on a new machine, run `mise run demo:browser:install` after `mise run bootstrap`. This installs the browser revision pinned by Playwright and its system dependencies; Linux may require elevated privileges for the system packages.
