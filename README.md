# robo-taxonomist

An Effect-based TypeScript library for taxonomic comparison, membership, and set algebra across databases, for browser and backend applications.

Early development. Text/record constructors, literal equality, and model-backed rank comparisons are implemented. Membership, set algebra, and npm publication are planned.

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

The question names the requested rank and quotes every supplied identifying field once. Conflicting labels, names, and IDs stay together; no field is chosen as authoritative. An omitted taxonomy release stays unspecified, not “latest.” Custom `DecisionModel` adapters receive `null` state: the record facts are already in the question. This presentation does not certify the model's answer.

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
