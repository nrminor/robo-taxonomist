import "server-only";
import { Effect, Exit, Layer, ManagedRuntime, Option, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { initialPanelId } from "../lib/catalog.ts";
import {
  ClassificationFailure,
  ClassificationReply,
  ClassifyRequest,
  PanelResponse,
} from "../lib/contract.ts";
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

const classifyRequest = Effect.fn("classifyRequest")(function* (request: Request) {
  const json = yield* Effect.tryPromise({
    try: (): Promise<unknown> => request.json(),
    catch: () => ClassificationFailure.cases.InvalidPanel.make({}),
  });
  const input = yield* Schema.decodeUnknownEffect(ClassifyRequest, {
    onExcessProperty: "error",
  })(json).pipe(Effect.mapError(() => ClassificationFailure.cases.InvalidPanel.make({})));
  return yield* classifyPanel(input.panelId);
});

const toInitialReply = (exit: Exit.Exit<PanelResponse, ClassificationFailure>): Schema.Json =>
  Exit.match(exit, {
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

const toHttpResponse = (exit: Exit.Exit<PanelResponse, ClassificationFailure>): Response =>
  Exit.match(exit, {
    onSuccess: (value) =>
      Response.json(encodeReply(Result.succeed(value)), {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }),
    onFailure: (cause) =>
      Option.match(publicCauseFailure(cause), {
        onNone: () => new Response(null, { status: 499, headers: { "Cache-Control": "no-store" } }),
        onSome: (failure) =>
          Response.json(encodeReply(Result.fail(failure)), {
            status: failureStatus(failure),
            headers: { "Cache-Control": "no-store" },
          }),
      }),
  });

export const makeHandlers = (
  runtime: ManagedRuntime.ManagedRuntime<PanelResults, ClassificationFailure>,
) => ({
  initialReply: async (): Promise<Schema.Json> =>
    toInitialReply(await runtime.runPromiseExit(classifyPanel(initialPanelId))),
  classifyHttp: async (request: Request): Promise<Response> =>
    toHttpResponse(
      await runtime.runPromiseExit(classifyRequest(request), { signal: request.signal }),
    ),
});

const runtime = ManagedRuntime.make(
  ConfiguredPanelResults.pipe(Layer.provide(FetchHttpClient.layer)),
);
export const { initialReply, classifyHttp } = makeHandlers(runtime);
