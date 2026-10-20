# robo-taxonomist

An Effect-based TypeScript library for taxonomic comparison, membership, and set algebra across databases, for browser and backend applications.

Early development. Text/record constructors, literal equality, rank and whole-taxon comparisons, record membership, symbolic set algebra, and batched collection workflows are implemented. npm publication is planned.

```ts
import { Effect, Match } from "effect";
import { RecordLabel, Taxonomy } from "robo-taxonomist";

export const program = Effect.gen(function* () {
  const first = yield* RecordLabel.makeEffect("Voucher A17 | Quercus robur");
  const second = yield* RecordLabel.makeEffect("Voucher B42 | Quercus robur");

  const result = yield* Taxonomy.sameSpecies(first, second);

  return Match.value(result).pipe(
    Match.tagsExhaustive({
      SameTaxonAtRank: () => "Same species",
      SameMultipleTaxaAtRank: () => "Same set of several species",
      SameTaxaAtRank: () => "Same species set; count uncertain",
      LeftTaxaWithinRightAtRank: () => "Left species form a proper subset of right species",
      RightTaxaWithinLeftAtRank: () => "Right species form a proper subset of left species",
      PartlySharedTaxaAtRank: () => "Some species shared; each side also has others",
      NoSharedTaxaAtRank: () => "No species shared",
      DifferentTaxaAtRank: () => "Unequal species sets; detailed relation uncertain",
      Undetermined: () => "Not enough information",
      MultipleTaxaAtRank: ({ side }) =>
        `A combined name on ${side} needs clarification before comparison.`,
    }),
  );
});
```

Provide your application's `DecisionModel` layer before running this Effect. Rank comparisons combine support for matching or differing taxon collections before applying the thresholds. More specific judgments require sufficient support too. Pass `{ policy: AcceptancePolicy.make({ minimumSupport: 0.95, minimumMargin: 0.25 }) }` for stricter reporting. Provider failures remain Effect errors.

`RecordLabel` describes a record; `TaxonName` describes a whole taxon. Constructors reject blank text and preserve accepted text exactly, without lookup. `TaxonomicRecord` accepts a label, scientific name, or scoped `TaxonId`, without requiring invented labels. `sameLabel` stays pure and compares only original text. Effect's AI APIs are currently unstable, even in Effect 4.

```ts
import { TaxonId, TaxonomicRecord, TaxonName, Taxonomy } from "robo-taxonomist";

const first = TaxonomicRecord.make({
  scientificName: TaxonName.make("Quercus robur"),
  taxonId: TaxonId.make({ taxonomy: "ncbi", id: "38942" }),
});
const second = TaxonomicRecord.make({
  scientificName: TaxonName.make("Quercus petraea"),
});

export const comparison = Taxonomy.sameGenus(first, second);
```

The rank question names the requested rank and quotes every supplied identifying field once. Conflicting labels, names, and IDs stay together; no field is chosen as authoritative. An omitted taxonomy release stays unspecified, not “latest.” Rank adapters receive `null` state: the record facts are already in the question. This presentation does not certify the model's answer.

Rank comparisons compare the taxa represented at the requested rank, including clear combinations. `SameTaxonAtRank` reports one shared taxon; `SameMultipleTaxaAtRank` reports several. `SameTaxaAtRank` leaves the count uncertain. `DifferentTaxaAtRank` reports unequal collections when their precise relation remains uncertain. Every judgment retains `rank`.

## Taxa, records, and sets

Use `sameTaxon` to ask whether names refer to the same taxon, including resolved synonyms. Use `taxonWithin(inner, outer)` to distinguish full inclusion, partial inclusion, and disjointness. `NotContained` preserves a negative answer when overlap remains uncertain.

```ts
import { TaxonName, Taxonomy } from "robo-taxonomist";

const oaks = TaxonName.make("Quercus");
const family = TaxonName.make("Fagaceae");
export const identity = Taxonomy.sameTaxon(oaks, family);
export const inclusion = Taxonomy.taxonWithin(oaks, family);
```

Construct a set expression when you want to combine whole taxa. Constructors are pure: they preserve your syntax without lookup, biological validation, or simplification. `complement(set, universe)` requires an explicit universe and means universe minus set.

```ts
import { Effect, Match } from "effect";
import { RecordLabel, TaxonName, Taxonomy, TaxonSet } from "robo-taxonomist";

const selected = TaxonSet.difference(
  TaxonSet.union(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagus"))),
  TaxonSet.of(TaxonName.make("Quercus robur")),
);

export const membership = Effect.gen(function* () {
  const result = yield* Taxonomy.recordBelongsTo(
    RecordLabel.make("Voucher A17 | Fagus sylvatica"),
    selected,
  );
  return Match.value(result).pipe(
    Match.tagsExhaustive({
      Member: () => "Every represented subject belongs",
      NotMember: () => "Every represented subject is outside",
      MixedMembership: () => "Some subjects belong; others lie outside",
      Undetermined: () => "Membership needs review",
      MultipleTaxaInTargetName: ({ targetName }) =>
        `Review the target name “${targetName}”. Use TaxonSet.union to combine separately constructed taxa.`,
    }),
  );
});

export const subset = TaxonSet.isSubsetOf(selected, TaxonSet.of(TaxonName.make("Fagaceae")));
```

Membership asks about the complete record and target. `MixedMembership` reports subjects inside and outside the target. A clarification result identifies the original supplied name or side (`left` means inner for `taxonWithin`). Clear combinations can be interpreted directly. Judgments and uncertainty are successful values; input and provider failures use `AiError`.

Set questions return `Yes`, `No`, `Undetermined`, or `MultipleTaxaInSetName`, retaining the asked `relation`. `isSubsetOf` includes equality; `isProperSubsetOf` additionally requires unequal sets. `equivalent` asks for equal organism sets, not taxonomic grouping identity. `overlaps` asks whether the sets share any organisms; `disjoint` maps one overlap judgment to its opposite while preserving uncertainty and diagnoses.

All these questions use your application's `DecisionModel` and accept the same `AcceptancePolicy`. By default, an answer needs at least half the support and a unique lead. Thresholds control reporting; model probabilities are not calibrated biological accuracy.

Each scalar, singleton membership, or set question makes one classification in one `DecisionModel.decide` call except for literal top-level `Empty` facts: membership is `NotMember`; an empty left is a subset; nothing is a proper subset of an empty right; two empty sets are equivalent; either empty operand prevents overlap and implies disjointness. These shortcuts do not inspect or certify the other operand. Nonliteral expressions such as `difference(A, A)` are not simplified and still need a judgment outside those cases.

Adapters receive null state for scalar questions, flat `{ nodes, left, right }` state for set questions, and flat `{ nodes, target }` state for membership questions. Numeric roots and child references index the shared `nodes` table; child rows can appear before or after their parents. Record facts occur once in membership questions. No provider, runtime, retry, cache, lookup, or consistency repair is supplied by the library.

## Collections

Keep the original records, including your own fields, in five membership buckets:

```ts
import { Effect } from "effect";
import { TaxonName, Taxonomy } from "robo-taxonomist";

const records = [
  { scientificName: TaxonName.make("Quercus robur"), sampleId: "A17" },
  { scientificName: TaxonName.make("Fagus sylvatica"), sampleId: "B42" },
];
const oaks = TaxonName.make("Quercus");

export const review = Effect.gen(function* () {
  const partition = yield* Taxonomy.partitionRecordsByMembership(records, oaks);
  return {
    memberIds: partition.pipe((value) => value.Member.map((record) => record.sampleId)),
    outside: partition.NotMember,
    mixed: partition.MixedMembership,
    uncertain: partition.Undetermined,
    nameProblems: partition.MultipleTaxaInTargetName.map(({ record, targetName }) => ({
      sampleId: record.sampleId,
      targetName,
    })),
  };
});

export const grouped = Taxonomy.groupRecordsByTaxa(records, [oaks, TaxonName.make("Fagaceae")]);
export const all = Taxonomy.allRecordsBelongTo(records, oaks);
export const any = Taxonomy.anyRecordBelongsTo(records, oaks);
export const none = Taxonomy.noRecordBelongsTo(records, oaks);
```

Partitions retain each original record occurrence and its order within the bucket, without cloning or deduplicating. Grouping returns `.groups`, one `{ target, partition }` per supplied target in order, including repeats; both the grouped value and each partition support `.pipe()`.

Groups may overlap, including when one supplied target contains another. Grouping does not choose a preferred rank or verify that targets are mutually exclusive. The same original record may appear in the Member buckets of multiple target partitions.

Quantifiers return `Yes`, `No`, `Undetermined`, or `MultipleTaxaInTargetName`, retaining `quantifier` (`all`, `any`, or `none`) and the diagnosed original `targetName` where applicable. Only a whole-record `Member` counts: a mixed record alone gives `No` for `any` and `Yes` for `none`. Empty records give `Yes` for `all`/`none` and `No` for `any`. Against literal `TaxonSet.empty()`, nonempty records give `No` for `all`/`any` and `Yes` for `none`; partitions put every record in `NotMember`. These cases make no model calls.

By default, collections classify up to 16 record occurrences per request, with one active batch call. Each request shares one complete target and asks one classification per record. Override the bounds for one operation:

```ts
import { CollectionExecution, RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";

export const partition = Taxonomy.partitionRecordsByMembership(
  [RecordLabel.make("Voucher A17 | Quercus robur")],
  TaxonName.make("Quercus"),
  { execution: CollectionExecution.make({ batchSize: 32, concurrency: 2 }) },
);
```

Grouping processes targets sequentially, so the cap does not multiply by target count. Independent operations have independent caps. These are record/request counts, not byte limits or measured optimal settings. Collections also accept the same optional `AcceptancePolicy`.

Quantifiers wait for each window of up to `concurrency` batches to succeed, then scan answers in input order. The first decisive membership answer or accepted name diagnosis wins; uncertainty is remembered if no later answer settles the question. No later window starts after settlement. Already-requested records may extend beyond that answer, and cancellation cannot recall sent requests. Any current-window failure fails the operation before its answers are scanned, even beside a decisive answer. Partitions and groups need every judgment and return no successful partial output. Defects and caller interruption retain normal Effect behavior.

## Inspecting expressions

Set tags and fields are available for application-owned traversal. Fields and operand arrays are readonly in TypeScript; this is not a runtime deep-freeze promise. Each constructor makes a fresh parent and union/intersection operand array, sharing existing children without changing them. Runtime schemas, classes, and wire codecs are not package exports.

```ts
import { Match } from "effect";
import { TaxonSet } from "robo-taxonomist";

export const describeSet = (set: TaxonSet.TaxonSet): string =>
  Match.value(set).pipe(
    Match.tagsExhaustive({
      Empty: () => "empty",
      Taxon: ({ name }) => name,
      Union: ({ operands }) => operands.map(describeSet).join(" | "),
      Intersection: ({ operands }) => operands.map(describeSet).join(" & "),
      Difference: ({ left, right }) => `(${describeSet(left)} minus ${describeSet(right)})`,
    }),
  );
```

## Development

Install [mise](https://mise.jdx.dev/) and Git, then review and trust the project configuration:

```sh
mise trust
mise bootstrap --only repos,tools,task
mise run check
```

Use `mise run check:fast` between edits. Run `mise tasks` to list the available commands.

## License

[MIT](LICENSE).
