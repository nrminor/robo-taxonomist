#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Match } from "effect";
import { CliOutput, Command } from "effect/cli";
import { cli } from "./cli.ts";

const Output = CliOutput.layerPresenter({
  present: Effect.fn("Cli.present")(function* (event: CliOutput.Presenter.Event) {
    const formatter = yield* CliOutput.Formatter;
    yield* Match.value(event).pipe(
      Match.tagsExhaustive({
        Help: CliOutput.defaultPresenter.present,
        Version: CliOutput.defaultPresenter.present,
        InvalidInvocation: ({ helpDoc, errors }) =>
          Console.error(`${formatter.formatHelpDoc(helpDoc)}\n${formatter.formatErrors(errors)}`),
      }),
    );
  }),
});

cli.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide([NodeServices.layer, Output]),
  NodeRuntime.runMain,
);
