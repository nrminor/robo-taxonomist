import { Effect, Match, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
import { classify } from "./classification.ts";
import * as Documents from "./documents.ts";
import * as Model from "./model.ts";
import { membership } from "./membership.ts";
import * as Output from "./output.ts";
import * as Presentation from "./presentation.ts";
import { sets } from "./sets.ts";

const labels = Command.make(
  "labels",
  {
    left: Argument.String("left").pipe(Argument.withSchema(RecordLabel)),
    right: Argument.String("right").pipe(Argument.withSchema(RecordLabel)),
  },
  Effect.fn("Cli.compareLabels")(function* ({ left, right }) {
    const sameLabel = Taxonomy.sameLabel(left, right);
    yield* Output.writeText(sameLabel);
  }),
).pipe(Command.withDescription("Compare the exact supplied record labels."));

const identity = Command.make(
  "identity",
  {
    left: Argument.String("left").pipe(Argument.withSchema(TaxonName)),
    right: Argument.String("right").pipe(Argument.withSchema(TaxonName)),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.compareIdentity")(function* ({ left, right, format, noHeader }) {
    const result = yield* Taxonomy.sameTaxon(left, right).pipe(Effect.mapError(Model.modelFailure));
    const row = Presentation.comparisonRow(result);
    const rows = Stream.make(row);
    const writeRows = Output.writeTable(Presentation.ComparisonRow, noHeader);
    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => writeRows(rows),
        json: () => Output.writeJson(result, Documents.IdentityJudgment),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withDescription(
    "Ask whether two taxonomic assignments refer to the same taxon.\n\n" + Model.modelHelp,
  ),
  Command.withExamples([
    {
      command: 'robo-taxonomist compare identity "Quercus robur" "English oak" --model your-model',
      description: "Compare two supplied taxonomic names.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);

const containment = Command.make(
  "containment",
  {
    inner: Argument.String("inner").pipe(Argument.withSchema(TaxonName)),
    outer: Argument.String("outer").pipe(Argument.withSchema(TaxonName)),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.compareContainment")(function* ({ inner, outer, format, noHeader }) {
    const result = yield* Taxonomy.taxonWithin(inner, outer).pipe(
      Effect.mapError(Model.modelFailure),
    );
    const row = Presentation.comparisonRow(result);
    const rows = Stream.make(row);
    const writeRows = Output.writeTable(Presentation.ComparisonRow, noHeader);
    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => writeRows(rows),
        json: () => Output.writeJson(result, Documents.ContainmentJudgment),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withAlias("within"),
  Command.withDescription(
    "Ask whether the inner taxon's organisms belong to the outer taxon. Left means inner; right means outer.\n\n" +
      Model.modelHelp,
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist cmp within Quercus Fagaceae --model your-model",
      description: "Ask whether the first taxon's organisms belong to the second.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
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
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.compareRank")(function* ({ left, right, rank, format, noHeader }) {
    const result = yield* Taxonomy.sameTaxonAtRank(left, right, rank).pipe(
      Effect.mapError(Model.modelFailure),
    );
    const row = Presentation.rankRow(result);
    const rows = Stream.make(row);
    const writeRows = Output.writeTable(Presentation.RankRow, noHeader);
    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => writeRows(rows),
        json: () => Output.writeJson(result, Documents.RankJudgment),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withDescription(
    "Compare two record labels at an explicit taxonomic rank. --rank is required; there is no default rank.\n\n" +
      Model.modelHelp,
  ),
  Command.withExamples([
    {
      command:
        'robo-taxonomist compare rank "Quercus robur" "Quercus petraea" --rank genus --model your-model',
      description: "Ask a rank-specific comparison without changing the supplied labels.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);

const compare = Command.make("compare").pipe(
  Command.withAlias("cmp"),
  Command.withDescription("Compare labels, taxonomic identity, rank and containment."),
  Command.withSubcommands([labels, identity, rank, containment]),
);

export const cli = Command.make("robo-taxonomist").pipe(
  Command.withDescription("Compare taxonomic records and compose symbolic taxon sets."),
  Command.withSubcommands([compare, sets, membership, classify]),
);
