import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { RecordLabel, Taxonomy } from "robo-taxonomist";

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

const compare = Command.make("compare").pipe(
  Command.withAlias("cmp"),
  Command.withDescription("Compare record labels."),
  Command.withSubcommands([labels]),
);

export const cli = Command.make("robo-taxonomist").pipe(
  Command.withDescription("Compare taxonomic record labels."),
  Command.withSubcommands([compare]),
);
