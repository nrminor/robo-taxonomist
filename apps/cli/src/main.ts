#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Match } from "effect";
import { CliOutput, Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Cli from "./cli.ts";

const banner = `
█████▄  ▄████▄ █████▄ ▄████▄   ██████ ▄████▄ ██  ██ ▄████▄ ███  ██ ▄████▄ ██▄  ▄██ ██ ▄█████ ██████
██▄▄██▄ ██  ██ ██▄▄██ ██  ██ ▄▄▄ ██   ██▄▄██  ████  ██  ██ ██ ▀▄██ ██  ██ ██ ▀▀ ██ ██ ▀▀▀▄▄▄   ██
██   ██ ▀████▀ ██▄▄█▀ ▀████▀     ██   ██  ██ ██  ██ ▀████▀ ██   ██ ▀████▀ ██    ██ ██ █████▀   ██

(COMMAND-LINE EDITION v${Cli.version})
`;

const Presenter = CliOutput.layerPresenter({
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

Cli.cli.pipe(
  Command.run({ version: Cli.version }),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer, Presenter]),
  NodeRuntime.runMain,
);
