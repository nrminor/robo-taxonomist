# `robo-taxonomist`

`robo-taxonomist` is a TypeScript library for biologists that provides utilities for resolving ambiguous taxonomic labels with decision models. For example, let's say you have the following taxon labels:

- "Voucher A17 | Quercus robur"
- "Voucher B42 | Fagus sylvatica"

Rather than using inscrutable and nested regex patterns and other techniques to identify whether these two labels are, say, within the same Order, `robo-taxonomist` leverages a decision model to give a clear, scored decision.

`robo-taxonomist` allows you to compare individual taxonomic records, test membership of one taxon within another, and build and compare sets of taxa. Using [Effect v4](https://effect.website/docs/v4/onboarding)'s AI API, it allows you to plug your own decision model of choice, supporting TypeSafe-AI's Jev, Cloudflare's Clef, OpenAI's decision API, and any other API-compatible model.

## Install

```sh
pnpm add robo-taxonomist
```

This release uses Effect 4.0.0. With default settings, pnpm and other package managers will automatically install the right version of Effect if missing. If your application already uses Effect, make sure its version satisfies the library's peer requirement.

Most operations in this library require internet access as well as access to a live decision model. Wire it up in an Effect `DecisionModel` layer, as demonstrated below.

## Example

Below is a complete example application using Effect and `robo-taxonomist`. It compares records, tests membership, and partitions records. As its model, it uses TypeSafe-AI's Jev; set `TYPESAFE_API_KEY` in your environment to try it yourself, or replace the model layer with another `DecisionModel`.

The example imports Effect directly and uses the TypeSafe provider adapter. Declare those dependencies explicitly in the example application:

```sh
pnpm add effect@4.0.0 @effect/ai-typesafe@4.0.0
```

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

  // 4. Classify the records against the taxa in a panel.
  // A record can match several targets; ranking keeps the accepted matches.
  const classified = yield* Taxonomy.classifyRecords([oak, beech], trees);

  // Buckets retain the original records, including sampleId.
  // Unresolved judgments stay separate so your application can review them.
  return {
    comparison,
    membership,
    memberIds: partition.Member.map((record) => record.sampleId),
    unresolvedIds: partition.Undetermined.map((record) => record.sampleId),
    matches: classified.records.map(({ record, ranking }) => ({
      sampleId: record.sampleId,
      taxa: ranking.map((match) => ({ name: match.taxon.name, support: match.support })),
    })),
  };
});

// Supply the model at the application boundary and run the complete program.
await Effect.runPromise(program.pipe(Effect.provide(DecisionModelLive), Effect.tap(Effect.log)));
```

With Node.js 24 or later, save the program as `example.mts` and run `node example.mts` after installing the packages and setting `TYPESAFE_API_KEY`. The `.mts` extension lets Node run this TypeScript example as an ES module.

The example returns the comparisons alongside your original sample identifiers and ranked matches. For these two records, you would expect different species, membership of the oak-and-beech target, and an oak in the `Quercus` partition. The answers come from the model, so the application also needs to handle unresolved results. With the default batching, a successful run makes four model calls: one each for the comparison, membership check, partition, and panel classification. The sections below explain those results and build on the same provider configuration.

## Contents

- [Working with taxonomic records](#working-with-taxonomic-records)
- [Comparing records and taxa](#comparing-records-and-taxa)
- [Building taxon sets](#building-taxon-sets)
- [Checking membership](#checking-membership)
- [Classifying records against a panel](#classifying-records-against-a-panel)
- [Choosing an acceptance policy](#choosing-an-acceptance-policy)
- [Working with collections](#working-with-collections)
- [Running model-backed operations](#running-model-backed-operations)

## Working with taxonomic records

A central challenge in working with biological data is that taxonomic classifications are often mashed up in catch-all labels with other kinds of information. For example, many metagenomic classifiers simply use reference index headers as taxonomic labels, and those headers (think NCBI accession names) are much more than scientific names. Similarly, sample IDs in an experiment may contain a taxonomic label as well as a voucher number and a collection site. Sometimes we just get identifiers like `9606`, which need some kind of taxonomic framework to give them meaning.

`robo-taxonomist` APIs accept a variety of different fields, e.g. raw record labels, scientific names, or taxon IDs, but allow you to keep other information from your experiment alongside them. For example:

```ts
import { RecordLabel, TaxonId, TaxonName, Taxonomy } from "robo-taxonomist";

const specimen = {
  sampleId: "A17",
  location: "Wytham Woods",
  label: RecordLabel.make("Voucher A17 | Quercus robur"),
  scientificName: TaxonName.make("Quercus robur"),
  taxonId: TaxonId.make({ taxonomy: "ncbi", id: "58334" }),
};

const reference = {
  scientificName: TaxonName.make("Quercus petraea"),
};

const comparison = Taxonomy.sameGenus(specimen, reference);
```

The actual comparison here uses just uses the `label` field, but the other information sticks around, including in the comparison result object. `robo-taxonomist` APIs for directly comparing records all accept either a simple `RecordLabel` (which is basically a non-empty string) or an object with at least one of `label`, `scientificName`, and `taxonId`. A `TaxonId` has a `taxonomy`, an `id`, and an optional `release`. Supplying the release lets you distinguish assignments made against different versions of a taxonomy. All of this information can inform the connected decision model.

`RecordLabel.make` and `TaxonName.make` validate that the text is nonblank. They preserve the supplied text, including its spelling, capitalization, and whitespace. They do not check whether a name is currently accepted or uniquely identifies a taxon. Likewise, supplying several identifying fields does not automatically audit whether they agree. If your application needs an authoritative current assignment, obtain it from your preferred taxonomy service and retain its provenance.

The `.make` constructors are synchronous and throw on invalid input. When validating input as part of an Effect program, use `.makeEffect` instead:

```ts
import { Effect } from "effect";
import { RecordLabel, Taxonomy } from "robo-taxonomist";

const compareHeaders = (left: string, right: string) =>
  Effect.gen(function* () {
    const first = yield* RecordLabel.makeEffect(left);
    const second = yield* RecordLabel.makeEffect(right);
    return yield* Taxonomy.sameSpecies(first, second);
  });
```

Here, a blank header fails validation before the model is called. A valid header with insufficient taxonomic information can instead produce an `Undetermined` judgment.

## Comparing records and taxa

Suppose two vouchers describe different species of oak. Their labels differ, but the organisms can still belong to the same genus, family, or order:

```ts
import { Effect } from "effect";
import { RecordLabel, Taxonomy } from "robo-taxonomist";

const compareOaks = Effect.gen(function* () {
  const first = RecordLabel.make("Voucher A17 | Quercus robur");
  const second = RecordLabel.make("Voucher B42 | Quercus petraea");

  const identicalText = Taxonomy.sameLabel(first, second);
  const genus = yield* Taxonomy.sameGenus(first, second);
  const species = yield* Taxonomy.sameSpecies(first, second);
  const family = yield* Taxonomy.sameTaxonAtRank(first, second, "family");

  return { identicalText, genus, species, family };
});
```

`sameLabel` is a deterministic, exact string comparison and returns a boolean immediately. The other calls ask the model about the taxa represented by the records and return Effects. Creating `compareOaks` describes that work; running it with a provider executes the questions, just as in the opening example.

`robo-taxonomist` provides a number of taxonomic-rank-specific helpers: `sameDomain`, `sameKingdom`, `samePhylum`, `sameClass`, `sameOrder`, `sameFamily`, `sameGenus`, and `sameSpecies`. Use `sameTaxonAtRank` when the rank is selected by your application. At the moment, `robo-taxonomist` supports `domain`, `kingdom`, `phylum`, `class`, `order`, `family`, `genus`, and `species` as rank strings.

A rank comparison returns a tagged judgment with a `rank` field. For a clear single-taxon match, the result has this shape:

```json
{ "_tag": "SameTaxonAtRank", "rank": "genus" }
```

Records can also describe combinations, and this is where the value of `robo-taxonomist` in handling the hierarchical nature of taxonomy becomes clearer. As an example, a record describing both `Quercus robur` and `Quercus petraea` represents one genus but two species. A comparison can report equality of several taxa, inclusion of one record's taxa in the other's, partial sharing, or no shared taxa. These cases are differentiated in the result object provided for each decision:

| Judgment                    | Interpretation at the requested rank                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `SameTaxonAtRank`           | Both records describe the same single taxon.                                             |
| `SameMultipleTaxaAtRank`    | Both describe the same collection of two or more taxa.                                   |
| `SameTaxaAtRank`            | The taxa match, but their number is unresolved.                                          |
| `LeftTaxaWithinRightAtRank` | The right record includes all the left record's taxa and additional taxa.                |
| `RightTaxaWithinLeftAtRank` | The left record includes all the right record's taxa and additional taxa.                |
| `PartlySharedTaxaAtRank`    | The records share some taxa and each also describes others.                              |
| `NoSharedTaxaAtRank`        | The records share no taxa at this rank.                                                  |
| `DifferentTaxaAtRank`       | A difference is accepted, but its finer relationship is unresolved.                      |
| `Undetermined`              | The comparison remains unresolved.                                                       |
| `MultipleTaxaAtRank`        | A combined assignment needs clarification; `side` identifies `left`, `right`, or `both`. |

For questions about supplied taxon names themselves, `robo-taxonomist` provides `sameTaxon` as well as set operations like `taxonWithin`:

```ts
import { Effect } from "effect";
import { TaxonName, Taxonomy } from "robo-taxonomist";

const compareNames = Effect.gen(function* () {
  const identity = yield* Taxonomy.sameTaxon(
    TaxonName.make("Escherichia coli"),
    TaxonName.make("Bacterium coli"),
  );
  const containment = yield* Taxonomy.taxonWithin(
    TaxonName.make("Quercus robur"),
    TaxonName.make("Fagaceae"),
  );
  return { identity, containment };
});
```

`sameTaxon` can recognize differently named references to the same taxon (you know, because the underlying model is smart). Its cases are `SameTaxon`, `DifferentTaxa`, `Undetermined`, and `MultipleTaxa`; with the last including the side of the comparison needing disambiguation. `taxonWithin(inner, outer)` asks whether the inner taxon's organism(s) belong to the outer taxon, including equality. It returns `Contained`, `PartlyContained`, `Disjoint`, `NotContained`, `Undetermined`, or `MultipleTaxa`.

`PartlyContained` establishes that some organisms are inside and some outside. `NotContained` establishes that the inner taxon is not wholly contained without settling whether it is partly inside or entirely disjoint. These broader answers let an application retain a useful conclusion while leaving a finer question open.

## Building taxon sets

`TaxonSet` lets you describe a target panel of taxa and then compare them via operations inspired by set algebra. For example, you might want members of Fagaceae other than oaks:

```ts
import { TaxonName, TaxonSet } from "robo-taxonomist";

const family = TaxonSet.of(TaxonName.make("Fagaceae"));
const oaks = TaxonSet.of(TaxonName.make("Quercus"));
const beeches = TaxonSet.of(TaxonName.make("Fagus"));

const oakOrBeech = TaxonSet.union(oaks, beeches);
const oaksInFamily = TaxonSet.intersection(oaks, family);
const otherFamilyMembers = TaxonSet.difference(family, oaks);
const exclusive = TaxonSet.symmetricDifference(oaks, beeches);
const remaining = TaxonSet.complement(oaks, family);
const empty = TaxonSet.empty();
```

`union`, `intersection`, and `difference` each take two set expressions. Combine those expressions again to build a larger target. `symmetricDifference` describes organisms in exactly one input set, and `complement(set, universe)` subtracts the set from the explicitly supplied universe. In this example, `remaining` and `otherFamilyMembers` describe the same directed difference.

To ask how the sets relate, run a relation question:

```ts
import { Effect } from "effect";
import { TaxonName, TaxonSet } from "robo-taxonomist";

const compareSets = Effect.gen(function* () {
  const oaks = TaxonSet.of(TaxonName.make("Quercus"));
  const family = TaxonSet.of(TaxonName.make("Fagaceae"));
  const shared = TaxonSet.intersection(oaks, family);

  const subset = yield* TaxonSet.isSubsetOf(oaks, family);
  const equivalent = yield* TaxonSet.equivalent(shared, oaks);
  const overlap = yield* TaxonSet.overlaps(oaks, family);

  return { subset, equivalent, overlap };
});
```

The available questions you can ask of taxon sets are `isSubsetOf`, `isProperSubsetOf`, `equivalent`, `overlaps`, and `disjoint`. Overlap asks whether there are any shared organisms, so equality and containment also count as overlap. A proper subset must exclude at least one organism from the containing set.

Rather than just reporting with booleans, these set relation questions return result objects that include a tag of `Yes`, `No`, or `Undetermined`; we recommend users handle these tags with exhaustive matching in Effect (see below). The result objects also include the `relation` that was asked. A `MultipleTaxaInSetName` result includes `side` and `taxonName` so you can review a name that appears to combine taxa. When you intend a union, build it from separate `TaxonSet.of` expressions, as above.

Literal empty sets allow some answers without a model call: an empty set is a subset of any set, and an empty set cannot overlap another set. Other expressions, including ones you expect to be equivalent or empty, still ask the model. Building an expression and establishing its biological meaning, in other words, are separate operations.

## Checking membership

Membership asks whether every subject described by a record belongs to the target. A sample describing both an oak and a beech can belong to an oak-or-beech target while having mixed membership in an oak-only target:

```ts
import { Effect, Match } from "effect";
import { RecordLabel, TaxonName, Taxonomy, TaxonSet } from "robo-taxonomist";

const checkSample = Effect.gen(function* () {
  const sample = RecordLabel.make("Mixed sample: Quercus robur and Fagus sylvatica");
  const target = TaxonSet.of(TaxonName.make("Quercus"));
  const result = yield* Taxonomy.recordBelongsTo(sample, target);

  return Match.value(result).pipe(
    Match.tagsExhaustive({
      Member: () => "Every subject described by this record belongs to the target.",
      NotMember: () => "Every subject described by this record is outside the target.",
      MixedMembership: () => "The record describes subjects both inside and outside the target.",
      Undetermined: () => "The supplied information does not settle membership.",
      MultipleTaxaInTargetName: ({ targetName }) => `Review the target name: ${targetName}`,
    }),
  );
});
```

The target can be a `TaxonName` directly or a `TaxonSet` expression. Use a name for a single whole taxon and an expression for combinations or exclusions. The model receives the whole expression when assessing membership.

Handle `MixedMembership` separately from `NotMember`: a mixed sample contains relevant organisms even though it does not wholly belong to the target. Likewise, `Undetermined` is a successful unresolved answer. A failed model request is reported through the Effect error channel, as described under [running model-backed operations](#running-model-backed-operations).

## Classifying records against a panel

Suppose you have records from a microbial sample and want to inspect which of several supplied taxa they match. Some targets might be broad, such as Fungi, while others identify a genus or species within them. Build a panel from those taxa and pass it to `classifyRecords`:

```ts
import { Effect } from "effect";
import { CollectionExecution, RecordLabel, TaxonName, Taxonomy, TaxonSet } from "robo-taxonomist";

const classifySample = Effect.gen(function* () {
  const records = [
    { id: "r1", scientificName: TaxonName.make("Saccharomyces cerevisiae"), abundance: 8 },
    { id: "r2", scientificName: TaxonName.make("Saccharomyces"), abundance: 3 },
    { id: "r3", label: RecordLabel.make("unclassified microorganism"), abundance: 2 },
  ];

  const fungi = TaxonSet.of(TaxonName.make("Fungi"));
  const genus = TaxonSet.of(TaxonName.make("Saccharomyces"));
  const species = TaxonSet.of(TaxonName.make("Saccharomyces cerevisiae"));
  const panel = TaxonSet.union(fungi, TaxonSet.union(genus, species));
  const execution = CollectionExecution.make({ batchSize: 4, concurrency: 1 });

  const result = yield* Taxonomy.classifyRecords(records, panel, { execution });

  return {
    records: result.records.map(({ record, taxa, ranking }) => ({
      id: record.id,
      abundance: record.abundance,
      matches: ranking.map((match) => ({ name: match.taxon.name, support: match.support })),
      decisions: taxa.map((match) => ({
        name: match.taxon.name,
        judgment: match.judgment._tag,
        label: match.answer.label,
        probabilities: match.answer.probabilities,
        confidence: match.answer.confidence,
      })),
    })),
    usage: result.usage,
  };
});
```

To run this program with the provider from the opening example:

```ts
await Effect.runPromise(
  classifySample.pipe(Effect.provide(DecisionModelLive), Effect.tap(Effect.log)),
);
```

Each row in `result.records` contains the original `record`, all candidate outcomes in `taxa`, and accepted matches in `ranking`. A match carries the original taxon, its `support`, its `judgment`, and the decision model's `answer`. The judgment is one of `Matched`, `NotMatched`, or `Undetermined`. The answer retains its chosen `label`, the probabilities for `sameTaxon`, `withinTaxon`, `noMatch`, and `undetermined`, and optional provider `confidence`. In other words, it's all there in the result object for your application to build logic around.

`ranking` contains only `Matched` entries, sorted by descending support. Equal scores retain the supplied occurrence order. `taxa` retains all outcomes in panel traversal order, so negative and unresolved answers remain available for inspection. The operation preserves repeated record and target occurrences rather than silently deduplicating them.

### Broad and specific targets can both match

As mentioned, taxonomy is inherently hierarchical; an identification of _Saccharomyces cerevisiae_ falls jointly under Fungi, Saccharomyces, and _Saccharomyces cerevisiae_. Handling this nestedness without complex hard-coded matching logic or a custom data structure can be difficult and brittle, and this is where `robo-taxonomist` leans instead on the intelligence of the decision model. The model will recognize that, for example, a genus-only identification of Saccharomyces can support a genus or broader classification, but is not sufficient evidence to establish membership within the particular species _Saccharomyces cerevisiae_.

For our _Saccharomyces cerevisiae_ example, all three matches are useful--it jointly falls within Fungi, Saccharomyces, and _Saccharomyces cerevisiae_. `robo-taxonomist` is built to preserve all matches when matching against a panel rather than forcing a choice of just one match. It does not automatically prefer the most specific taxonomic rank, select one bin per record, or split a record among competing bins. Furthermore, all matches are scored (see next section) and ranked, giving your application control over what's done with the model's judgments.

### Support, confidence, and abundance describe different things

For panel classification, match support combines the probability assigned to `sameTaxon` and `withinTaxon`, divided by the total probability mass of the four choices. For example, probabilities of `0.35` for the same taxon, `0.55` for classification within it, `0.05` for no match, and `0.05` for uncertainty give match support of `0.90`.

In panel classifications and elsewhere in the library, acceptance thresholds can be fine-tuned with what we call the "acceptance policy". For combined support like in the above, the policy ultimately controls how `robo-taxonomist` weighs support against the negative and uncertain alternatives. A low match score alone does not establish `NotMatched`: there must be acceptable evidence specifically for the negative answer. If no answer meets the policy, the judgment remains `Undetermined`. This is key! It's how `robo-taxonomist` handles the transition from a non-deterministic model to deterministic programs.

That said, neither a support value of `0.90` nor the underlying model provider's confidence establishes 90% empirical accuracy. Evaluate the model and acceptance policy on representative records with independently checked answers when you need a measured error rate.

## Choosing an acceptance policy

An acceptance policy controls how much model-reported support and separation from competing answers the library requires before reporting a judgment:

```ts
import { Effect } from "effect";
import { AcceptancePolicy, RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";

const conservativeMembership = Effect.gen(function* () {
  const policy = AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0.15 });
  return yield* Taxonomy.recordBelongsTo(
    RecordLabel.make("Voucher A17 | Quercus robur"),
    TaxonName.make("Fagaceae"),
    { policy },
  );
});
```

The defaults are `minimumSupport: 0.5` and `minimumMargin: 0`. Thresholds are inclusive, but an accepted answer must always have a unique lead: an exact tie remains unresolved even when the required margin is zero. Margin measures the lead over the strongest competing answer, including uncertainty and clarification choices. Both policy values must be between zero and one.

Increasing the thresholds changes what the application accepts; it does not improve the model's underlying confidence. A stricter policy will generally leave more cases unresolved; `robo-taxonomist` leaves it to users to decide what their application should do with those records—for example, retain them for review rather than dropping them from a sample summary.

## Working with collections

Use `partitionRecordsByMembership` when you want the original records separated into membership outcomes for one target. For example, keep the matching specimen IDs and the records needing review:

```ts
import { Effect } from "effect";
import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";

const partitionSamples = Effect.gen(function* () {
  const records = [
    { id: "A17", label: RecordLabel.make("Voucher A17 | Quercus robur") },
    { id: "B42", label: RecordLabel.make("Voucher B42 | Fagus sylvatica") },
    { id: "C09", label: RecordLabel.make("Fagaceae; genus unresolved") },
  ];
  const partition = yield* Taxonomy.partitionRecordsByMembership(
    records,
    TaxonName.make("Quercus"),
  );

  return {
    members: partition.Member.map((record) => record.id),
    outside: partition.NotMember.map((record) => record.id),
    mixed: partition.MixedMembership.map((record) => record.id),
    unresolved: partition.Undetermined.map((record) => record.id),
    targetNamesToReview: partition.MultipleTaxaInTargetName.map(({ record, targetName }) => ({
      id: record.id,
      targetName,
    })),
  };
});
```

Each bucket preserves input order, repeated occurrences, and the original record. The `MultipleTaxaInTargetName` bucket retains both the record and the target name identified by the model. A partition with no records returns empty buckets without calling the model.

For several membership targets, `groupRecordsByTaxa` returns a partition for each target, in target order:

```ts
import { Effect } from "effect";
import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";

const groupSamples = Effect.gen(function* () {
  const records = [
    { id: "A17", label: RecordLabel.make("Voucher A17 | Quercus robur") },
    { id: "B42", label: RecordLabel.make("Voucher B42 | Fagus sylvatica") },
  ];
  return yield* Taxonomy.groupRecordsByTaxa(records, [
    TaxonName.make("Quercus"),
    TaxonName.make("Fagaceae"),
  ]);
});
```

The return value has a `groups` array whose entries contain `target` and `partition`. These groups can overlap: an oak record may belong to both Quercus and Fagaceae. `groupRecordsByTaxa` runs membership partitions against the supplied targets; `classifyRecords` instead assesses the offered taxa in the context of one complete panel and returns scored matches and rankings. Choose according to the question and output you need.

### Asking a question about the whole collection

If you need a collection-wide answer rather than every row, use `allRecordsBelongTo`, `anyRecordBelongsTo`, or `noRecordBelongsTo`:

```ts
import { Effect } from "effect";
import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";

const checkCollection = Effect.gen(function* () {
  const records = [RecordLabel.make("Quercus robur"), RecordLabel.make("Fagus sylvatica")];
  const target = TaxonName.make("Fagaceae");

  const all = yield* Taxonomy.allRecordsBelongTo(records, target);
  const any = yield* Taxonomy.anyRecordBelongsTo(records, target);
  const none = yield* Taxonomy.noRecordBelongsTo(records, target);

  return { all, any, none };
});
```

Each answer has `_tag: "Yes"`, `"No"`, or `"Undetermined"` and a `quantifier` of `"all"`, `"any"`, or `"none"`. A clarification result uses `MultipleTaxaInTargetName` with that quantifier and the target name.

These questions concern whole-record membership, which means they will provide a clearest answer when that record represents only one taxonomic entity. A record describing both an oak and a bacterium, for example, does not wholly belonging to Fagaceae, even though it mentions an organism in that family. `anyRecordBelongsTo` asks whether any record object wholly belongs; it does not ask whether any subject mentioned within any record is inside the target.

Quantifiers can stop before examining every later batch once the answer is settled. With concurrency greater than one, requests in the current window can already be in flight. Separate calls to `all`, `any`, and `none` are separate operations; run just the question you need if you do not want three sets of requests. Like elsewhere in the API, empty collections are handled deterministically, without a model call; `all` and `none` return `Yes`, while `any` returns `No`.

## Running model-backed operations

The examples above construct Effect programs. Supply a `DecisionModel` layer at the application boundary, as in the opening example, and run the program there. The same configured layer can be used for comparisons, membership questions, set relations, and collection operations.

For example, to run the membership program and handle its result through Effect:

```ts
await Effect.runPromise(
  checkSample.pipe(Effect.provide(DecisionModelLive), Effect.tap(Effect.log)),
);
```

An operation that reports `Undetermined` has completed successfully. Invalid inputs and provider failures travel through the Effect error channel. Model-backed library operations report `AiError`; validation performed with a schema's `.makeEffect` can also introduce a schema error into your larger program.

For a service or command that needs to handle provider failure explicitly, inspect the typed error rather than substituting an empty successful result:

```ts
import { Effect } from "effect";
import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";

const membershipResult = Taxonomy.recordBelongsTo(
  RecordLabel.make("Voucher A17 | Quercus robur"),
  TaxonName.make("Quercus"),
).pipe(
  Effect.match({
    onFailure: (error) => ({ status: "failed", reason: error.reason._tag }),
    onSuccess: (judgment) => ({ status: "completed", judgment }),
  }),
);
```

This retains the distinction between a failed request and a completed taxonomic judgment. Choose what to log or expose from an error at your application's boundary; provider errors can carry request or response details. Interruption and unexpected defects are also distinct from a successful `Undetermined` judgment.

### Batching and concurrency

Collection operations accept an `execution` option alongside the optional acceptance `policy`:

```ts
import {
  AcceptancePolicy,
  CollectionExecution,
  RecordLabel,
  TaxonName,
  Taxonomy,
} from "robo-taxonomist";

const records = [
  { id: "A17", label: RecordLabel.make("Voucher A17 | Quercus robur") },
  { id: "B42", label: RecordLabel.make("Voucher B42 | Fagus sylvatica") },
];
const execution = CollectionExecution.make({ batchSize: 8, concurrency: 2 });
const policy = AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 });

const partition = Taxonomy.partitionRecordsByMembership(records, TaxonName.make("Fagaceae"), {
  execution,
  policy,
});
```

The defaults are 16 records per batch and one active batch request within a collection operation. Both configured values must be positive integers. Larger batches reduce the number of requests but increase the amount of information and number of decisions in each request.

For classification, each record is assessed against each offered panel taxon. A batch of 16 records and 10 taxa therefore asks 160 classification decisions in one batch request. Check your chosen provider's limits when selecting a batch size. Concurrency controls active batch calls within the operation; it is not an application-wide rate limit across independently running programs. `groupRecordsByTaxa` assesses targets sequentially and applies the execution settings to each target's membership batches.

### Repeated calls and cancellation

Running the same Effect again can make new model requests. The library does not automatically cache earlier judgments, retry failed requests, or impose a spending budget. These concerns belong to the application and its configured model layer. In particular, using the same provider layer for two separate taxonomy calls does not make them one combined request.

Keep cancellation within the Effect workflow. For example, an application can give classification a two-minute deadline:

```ts
const boundedClassification = classifySample.pipe(Effect.timeout("2 minutes"));

await Effect.runPromise(boundedClassification.pipe(Effect.provide(DecisionModelLive)));
```

If the deadline expires, `Effect.timeout` interrupts the classification and fails with a typed `TimeoutError`, which the surrounding Effect program can handle. This deadline is an application choice, not a library default. For concurrent work owned by a scope, `Effect.forkScoped` ties the child fiber's lifetime to that scope; closing the scope interrupts the child and runs its cleanup.

Stopping an already dispatched network request depends on the provider and transport responding to interruption. Cancellation does not guarantee that a provider will waive charges for work already started.

Keep credentials in the environment appropriate to your application: a browser-delivered provider key is visible to the people running that browser.
