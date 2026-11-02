import { Effect, Match } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
import appPackage from "../package.json" with { type: "json" };
import { classify } from "./classification.ts";
import * as Documents from "./documents.ts";
import * as Model from "./model.ts";
import { membership } from "./membership.ts";
import * as Output from "./output.ts";
import { sets } from "./sets.ts";
import * as Server from "./server.ts";

/** Use the application package version for the CLI runner and help banner. */
export const version = appPackage.version;

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
).pipe(
  Command.withShortDescription("Compare exact record labels."),
  Command.withDescription("Compare the exact supplied record labels; no model is needed."),
  Command.withExamples([
    {
      command: 'robo-taxonomist compare labels "Voucher A17" "Voucher A17"',
      description: "Print true if the labels are identical, otherwise false.",
    },
  ]),
);

const identity = Command.make(
  "identity",
  {
    left: Argument.String("left").pipe(Argument.withSchema(TaxonName)),
    right: Argument.String("right").pipe(Argument.withSchema(TaxonName)),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(
      Flag.withDefault("tsv"),
      Flag.withDescription("Write the judgment as tab-delimited CSV (default) or JSON."),
    ),
    noHeader: Flag.Boolean("no-header").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Omit the table header."),
    ),
  },
  Effect.fn("Cli.compareIdentity")(function* ({ left, right, format, noHeader }) {
    const result = yield* Taxonomy.sameTaxon(left, right).pipe(Effect.mapError(Model.modelFailure));
    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => Output.writeComparison(result, noHeader),
        json: () => Output.writeJson(result, Documents.IdentityJudgment),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withShortDescription("Compare taxonomic identities."),
  Command.withDescription("Ask whether two taxonomic names refer to the same taxon."),
  Command.withExamples([
    {
      command: 'robo-taxonomist compare identity "Quercus robur" "English oak"',
      description: "Compare two supplied taxonomic names.",
    },
    {
      command:
        'robo-taxonomist compare identity "Quercus robur" "English oak" --model another-model',
      description: "Use a different model for this command.",
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
    format: Flag.Literals("format", ["tsv", "json"]).pipe(
      Flag.withDefault("tsv"),
      Flag.withDescription("Write the judgment as tab-delimited CSV (default) or JSON."),
    ),
    noHeader: Flag.Boolean("no-header").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Omit the table header."),
    ),
  },
  Effect.fn("Cli.compareContainment")(function* ({ inner, outer, format, noHeader }) {
    const result = yield* Taxonomy.taxonWithin(inner, outer).pipe(
      Effect.mapError(Model.modelFailure),
    );
    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => Output.writeComparison(result, noHeader),
        json: () => Output.writeJson(result, Documents.ContainmentJudgment),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withAlias("within"),
  Command.withShortDescription("Check whether one taxon falls within another."),
  Command.withDescription(
    "Ask whether the inner taxon's organisms belong to the outer taxon. In the result, left means inner and right means outer.",
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist cmp within Quercus Fagaceae",
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
    ]).pipe(Flag.withDescription("Taxonomic rank at which to compare the records.")),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(
      Flag.withDefault("tsv"),
      Flag.withDescription("Write the judgment as tab-delimited CSV (default) or JSON."),
    ),
    noHeader: Flag.Boolean("no-header").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Omit the table header."),
    ),
  },
  Effect.fn("Cli.compareRank")(function* ({ left, right, rank, format, noHeader }) {
    const result = yield* Taxonomy.sameTaxonAtRank(left, right, rank).pipe(
      Effect.mapError(Model.modelFailure),
    );
    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => Output.writeRank(result, noHeader),
        json: () => Output.writeJson(result, Documents.RankJudgment),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withShortDescription("Compare records at a taxonomic rank."),
  Command.withDescription("Compare two record labels at the specified taxonomic rank."),
  Command.withExamples([
    {
      command: 'robo-taxonomist compare rank "Quercus robur" "Quercus petraea" --rank genus',
      description: "Ask a rank-specific comparison without changing the supplied labels.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);

const compare = Command.make("compare").pipe(
  Command.withAlias("cmp"),
  Command.withShortDescription("Compare labels and taxonomic identities."),
  Command.withDescription("Compare labels, taxonomic identity, rank and containment."),
  Command.withSubcommands([labels, identity, rank, containment]),
);

/** Assemble local taxonomy commands and the foreground HTTP server command. */
export const cli = Command.make("robo-taxonomist").pipe(
  Command.withDescription(
    "Compare taxonomic records and compose taxon sets.\n\nUse <command> --help for options and examples.",
  ),
  Command.withSubcommands([compare, sets, membership, classify, Server.command]),
);
