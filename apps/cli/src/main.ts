#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Match } from "effect";
import { CliOutput, Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { cli } from "./cli.ts";

const banner = `
█████▄  ▄████▄ █████▄ ▄████▄   ██████ ▄████▄ ██  ██ ▄████▄ ███  ██ ▄████▄ ██▄  ▄██ ██ ▄█████ ██████
██▄▄██▄ ██  ██ ██▄▄██ ██  ██ ▄▄▄ ██   ██▄▄██  ████  ██  ██ ██ ▀▄██ ██  ██ ██ ▀▀ ██ ██ ▀▀▀▄▄▄   ██
██   ██ ▀████▀ ██▄▄█▀ ▀████▀     ██   ██  ██ ██  ██ ▀████▀ ██   ██ ▀████▀ ██    ██ ██ █████▀   ██

(COMMAND-LINE EDITION)
`;

const Output = CliOutput.layerPresenter({
  present: Effect.fn("Cli.present")(function* (event: CliOutput.Presenter.Event) {
    const formatter = yield* CliOutput.Formatter;
    yield* Match.value(event).pipe(
      Match.tagsExhaustive({
        Help: (event) =>
          Effect.gen(function* () {
            if (event.commandPath.length === 1) yield* Console.log(banner);
            yield* CliOutput.defaultPresenter.present(event);
          }),
        Version: CliOutput.defaultPresenter.present,
        InvalidInvocation: ({ helpDoc, errors }) =>
          Console.error(`${formatter.formatHelpDoc(helpDoc)}\n${formatter.formatErrors(errors)}`),
      }),
    );
  }),
});

cli.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer, Output]),
  NodeRuntime.runMain,
);
