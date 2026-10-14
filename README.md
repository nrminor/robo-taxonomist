# robo-taxonomist

An Effect-based TypeScript library for taxonomic comparison, membership, and set algebra across databases, for browser and backend applications.

Early development. Text/record constructors, literal equality, rank and whole-taxon comparisons, singleton record membership, and symbolic set algebra are implemented. Collection workflows and npm publication are planned.

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
      DifferentTaxaAtRank: () => "Different species",
      Undetermined: () => "Not enough information",
      MultipleTaxaAtRank: ({ side }) =>
        `The model reads ${side} as describing multiple species. This comparison needs one species assignment per record.`,
    }),
  );
});
```

Provide your application's `DecisionModel` layer before running this Effect. Results are model judgments, not biological certification; provider failures remain Effect errors. The default reports a selected label only when it has at least half the support and uniquely leads. Pass `{ policy: RankComparisonPolicy.make({ minimumSupport: 0.95, minimumMargin: 0.25 }) }` for stricter reporting.

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

## Taxa, records, and sets

Use `sameTaxon` for the same taxonomic grouping, including resolved synonyms. Use `taxonWithin(inner, outer)` when every organism belonging to the inner taxon must belong to the outer; equality counts. Neither `DifferentTaxa` nor `NotContained` establishes disjointness.

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
      MixedMembership: () => "Subjects are established both inside and outside",
      Undetermined: () => "Membership needs review",
      MultipleTaxaInTargetName: ({ targetName }) =>
        `Review the target name “${targetName}”. Use TaxonSet.union to combine separately constructed taxa.`,
    }),
  );
});

export const subset = TaxonSet.isSubsetOf(selected, TaxonSet.of(TaxonName.make("Fagaceae")));
```

Membership asks about the complete record and target. Multiple subjects alone do not establish `MixedMembership`. A target-name diagnosis identifies an original supplied name; it does not split it, invent a replacement, or certify the other names. Scalar `MultipleTaxa` diagnoses retain the original side (`left` means inner for `taxonWithin`). Diagnoses and uncertainty are successful results, separate from `AiError` failures.

Set questions return `Yes`, `No`, `Undetermined`, or `MultipleTaxaInSetName`, retaining the asked `relation`. `isSubsetOf` includes equality; `isProperSubsetOf` additionally requires unequal sets. `equivalent` asks for equal organism sets, not taxonomic grouping identity. `overlaps` asks whether the sets share any organisms; `disjoint` maps one overlap judgment to its opposite while preserving uncertainty and diagnoses.

All these questions use your application's `DecisionModel`. Pass `{ policy: JudgmentPolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 }) }` to change non-rank thresholds. The default requires at least half the support and a uniquely leading selected answer. Thresholds are reporting preferences, not calibrated biological accuracy; separate calls need not agree.

Each execution makes one classification in one `DecisionModel.decide` call except for literal top-level `Empty` facts: membership is `NotMember`; an empty left is a subset; nothing is a proper subset of an empty right; two empty sets are equivalent; either empty operand prevents overlap and establishes disjointness. These shortcuts do not inspect or certify the other operand. Nonliteral expressions such as `difference(A, A)` are not simplified and still need a judgment outside those cases.

Adapters receive null state for scalar questions, encoded `{ left, right }` for set questions, and only the shared target for membership. Record facts occur once in membership questions. No provider, runtime, retry, cache, lookup, or consistency repair is supplied by the library.

### Inspecting expressions

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
