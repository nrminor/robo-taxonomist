import "server-only";
import { Effect, Exit, Layer, ManagedRuntime, Option, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { initialPanelId } from "../lib/catalog.ts";
import { ClassificationFailure, ClassificationReply, ClassifyRequest } from "../lib/contract.ts";
import { publicCauseFailure } from "../lib/failures.ts";
import { classifyPanel, PanelResults } from "./panel-results.ts";
import { ConfiguredPanelResults } from "./configured-model.ts";

const encodeReply = Schema.encodeSync(ClassificationReply);

const failureStatus = (failure: ClassificationFailure): number =>
  ClassificationFailure.match(failure, {
    InvalidPanel: () => 400,
    ModelFailure: () => 503,
    ConfigurationFailure: () => 503,
    InternalFailure: () => 500,
  });

export function makeHandlers(
  runtime: ManagedRuntime.ManagedRuntime<PanelResults, ClassificationFailure>,
) {
  async function initialReply(): Promise<Schema.Json> {
    const exit = await runtime.runPromiseExit(classifyPanel(initialPanelId));
    return Exit.match(exit, {
      onSuccess: (value) => encodeReply(Result.succeed(value)),
      // There is no user signal here. An internal interruption resolves to a safe
      // failure instead of rejecting an RSC promise with an Effect cause.
      onFailure: (cause) =>
        encodeReply(
          Result.fail(
            Option.getOrElse(publicCauseFailure(cause), () =>
              ClassificationFailure.cases.InternalFailure.make({}),
            ),
          ),
        ),
    });
  }

  async function classifyHttp(request: Request): Promise<Response> {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const json = yield* Effect.tryPromise({
          try: (): Promise<unknown> => request.json(),
          catch: () => ClassificationFailure.cases.InvalidPanel.make({}),
        });
        const input = yield* Schema.decodeUnknownEffect(ClassifyRequest, {
          onExcessProperty: "error",
        })(json).pipe(Effect.mapError(() => ClassificationFailure.cases.InvalidPanel.make({})));
        return yield* classifyPanel(input.panelId);
      }),
      { signal: request.signal },
    );
    return Exit.match(exit, {
      onSuccess: (value) =>
        Response.json(encodeReply(Result.succeed(value)), {
          status: 200,
          headers: { "Cache-Control": "no-store" },
        }),
      onFailure: (cause) =>
        Option.match(publicCauseFailure(cause), {
          onNone: () =>
            new Response(null, { status: 499, headers: { "Cache-Control": "no-store" } }),
          onSome: (failure) =>
            Response.json(encodeReply(Result.fail(failure)), {
              status: failureStatus(failure),
              headers: { "Cache-Control": "no-store" },
            }),
        }),
    });
  }

  return { initialReply, classifyHttp };
}

declare global {
  var __roboTaxonomistDemoRuntime:
    | ManagedRuntime.ManagedRuntime<PanelResults, ClassificationFailure>
    | undefined;
}

// Share one cache across server rendering, POST requests, and development module reloads.
globalThis.__roboTaxonomistDemoRuntime ??= ManagedRuntime.make(
  ConfiguredPanelResults.pipe(Layer.provide(FetchHttpClient.layer)),
);
export const { initialReply, classifyHttp } = makeHandlers(globalThis.__roboTaxonomistDemoRuntime);
