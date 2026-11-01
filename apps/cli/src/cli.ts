import { Console, Effect, Match } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
import { modelFailure, modelFlag, modelHelp, modelLayer } from "./model.ts";
import { sets } from "./sets.ts";

const labels = Command.make(
  "labels",
  {
    left: Argument.String("left").pipe(Argument.withSchema(RecordLabel)),
    right: Argument.String("right").pipe(Argument.withSchema(RecordLabel)),
  },
  Effect.fn("Cli.compareLabels")(function* ({ left, right }) {
    yield* Console.log(Taxonomy.sameLabel(left, right));
  }),
).pipe(Command.withDescription("Compare the exact supplied record labels."));

const identity = Command.make(
  "identity",
  {
    left: Argument.String("left").pipe(Argument.withSchema(TaxonName)),
    right: Argument.String("right").pipe(Argument.withSchema(TaxonName)),
    model: modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.compareIdentity")(function* ({ left, right, format, noHeader }) {
    const result = yield* Taxonomy.sameTaxon(left, right).pipe(Effect.mapError(modelFailure));
    if (format === "json") {
      yield* Console.log(JSON.stringify(result));
      return;
    }
    const [judgment, side] = Match.value(result).pipe(
      Match.tagsExhaustive({
        SameTaxon: () => ["SameTaxon", ""],
        DifferentTaxa: () => ["DifferentTaxa", ""],
        Undetermined: () => ["Undetermined", ""],
        MultipleTaxa: ({ side }) => ["MultipleTaxa", side],
      }),
    );
    if (!noHeader) yield* Console.log("judgment\tside");
    yield* Console.log(`${judgment}\t${side}`);
  }),
).pipe(
  Command.withDescription(
    "Ask whether two taxonomic assignments refer to the same taxon.\n\n" + modelHelp,
  ),
  Command.withExamples([
    {
      command: 'robo-taxonomist compare identity "Quercus robur" "English oak" --model your-model',
      description: "Compare two supplied taxonomic names.",
    },
  ]),
  Command.provide(({ model }) => modelLayer(model)),
);

const containment = Command.make(
  "containment",
  {
    inner: Argument.String("inner").pipe(Argument.withSchema(TaxonName)),
    outer: Argument.String("outer").pipe(Argument.withSchema(TaxonName)),
    model: modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.compareContainment")(function* ({ inner, outer, format, noHeader }) {
    const result = yield* Taxonomy.taxonWithin(inner, outer).pipe(Effect.mapError(modelFailure));
    if (format === "json") {
      yield* Console.log(JSON.stringify(result));
      return;
    }
    const [judgment, side] = Match.value(result).pipe(
      Match.tagsExhaustive({
        Contained: () => ["Contained", ""],
        PartlyContained: () => ["PartlyContained", ""],
        Disjoint: () => ["Disjoint", ""],
        NotContained: () => ["NotContained", ""],
        Undetermined: () => ["Undetermined", ""],
        MultipleTaxa: ({ side }) => ["MultipleTaxa", side],
      }),
    );
    if (!noHeader) yield* Console.log("judgment\tside");
    yield* Console.log(`${judgment}\t${side}`);
  }),
).pipe(
  Command.withAlias("within"),
  Command.withDescription(
    "Ask whether the inner taxon's organisms belong to the outer taxon. Left means inner; right means outer.\n\n" +
      modelHelp,
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist cmp within Quercus Fagaceae --model your-model",
      description: "Ask whether the first taxon's organisms belong to the second.",
    },
  ]),
  Command.provide(({ model }) => modelLayer(model)),
);

const rank = Command.make(
  "rank",
  {
    left: Argument.String("left").pipe(Argument.withSchema(RecordLabel)),
    right: Argument.String("right").pipe(Argument.withSchema(RecordLabel)),
    rank: Flag.Literals("rank", [
      "domain",
      "kingdom",
      "phylum",
      "class",
      "order",
      "family",
      "genus",
      "species",
    ]),
    model: modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.compareRank")(function* ({ left, right, rank, format, noHeader }) {
    const result = yield* Taxonomy.sameTaxonAtRank(left, right, rank).pipe(
      Effect.mapError(modelFailure),
    );
    if (format === "json") {
      yield* Console.log(JSON.stringify(result));
      return;
    }
    const [judgment, side] = Match.value(result).pipe(
      Match.tagsExhaustive({
        SameTaxonAtRank: () => ["SameTaxonAtRank", ""],
        SameMultipleTaxaAtRank: () => ["SameMultipleTaxaAtRank", ""],
        SameTaxaAtRank: () => ["SameTaxaAtRank", ""],
        LeftTaxaWithinRightAtRank: () => ["LeftTaxaWithinRightAtRank", ""],
        RightTaxaWithinLeftAtRank: () => ["RightTaxaWithinLeftAtRank", ""],
        PartlySharedTaxaAtRank: () => ["PartlySharedTaxaAtRank", ""],
        NoSharedTaxaAtRank: () => ["NoSharedTaxaAtRank", ""],
        DifferentTaxaAtRank: () => ["DifferentTaxaAtRank", ""],
        Undetermined: () => ["Undetermined", ""],
        MultipleTaxaAtRank: ({ side }) => ["MultipleTaxaAtRank", side],
      }),
    );
    if (!noHeader) yield* Console.log("judgment\trank\tside");
    yield* Console.log(`${judgment}\t${result.rank}\t${side}`);
  }),
).pipe(
  Command.withDescription(
    "Compare two record labels at an explicit taxonomic rank. --rank is required; there is no default rank.\n\n" +
      modelHelp,
  ),
  Command.withExamples([
    {
      command:
        'robo-taxonomist compare rank "Quercus robur" "Quercus petraea" --rank genus --model your-model',
      description: "Ask a rank-specific comparison without changing the supplied labels.",
    },
  ]),
  Command.provide(({ model }) => modelLayer(model)),
);

const compare = Command.make("compare").pipe(
  Command.withAlias("cmp"),
  Command.withDescription("Compare labels, taxonomic identity, rank and containment."),
  Command.withSubcommands([labels, identity, rank, containment]),
);

export const cli = Command.make("robo-taxonomist").pipe(
  Command.withDescription("Compare taxonomic records and compose symbolic taxon sets."),
  Command.withSubcommands([compare, sets]),
);
