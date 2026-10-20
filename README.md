# `robo-taxonomist`

`robo-taxonomist` is a TypeScript library for biologists that provides utilities for resolving ambiguous taxonomic labels with decision models. For example, let's say you have the following taxon labels:

- "Voucher A17 | Quercus robur"
- "Voucher B42 | Fagus sylvatica"

Rather than using inscrutable and nested regex patterns and other techniques to identify whether these two labels are, say, within the same Order, `robo-taxonomist` leverages a decision model to give a clear, calibrated decision.

`robo-taxonomist` alows you to compare individual taxonomic records, test membership of one taxon within another, and build and compare sets of taxa. Using [Effect v4](https://effect.website/docs/v4/onboarding)'s AI API, it allows you to plug your own decision model of choice, supporting TypeSafe-AI's Jev, Cloudflare's Clef, OpenAI's decision API, and any other API-compatible model.

Version `0.1.0` is being prepared for a GitHub release. Nothing has been published to npm yet.

## Install

For now, build a checkout with [mise](https://mise.jdx.dev/):

```sh
mise trust
mise run bootstrap
mise run build
mise run pack
mise run check:package -- artifacts/robo-taxonomist-0.1.0.tgz
```

Then, from your application, install the checked tarball and the provider used below:

```sh
pnpm add /path/to/robo-taxonomist/artifacts/robo-taxonomist-0.1.0.tgz effect@4.0.0 @effect/ai-typesafe@4.0.0
```

The package check installs the tarball outside the checkout and checks JavaScript, declarations, and basic browser bundling. It does not establish full browser support or model accuracy. After release, the same tested tarball and its SHA-256 checksum will be available on GitHub. Maintainers release only by pushing an approved tag matching the package version; the tag workflow checks, packs, and tests before uploading assets to a draft and making it public.

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
