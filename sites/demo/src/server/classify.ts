import "server-only";
import { Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ClassificationFailure, ClassifyRequest, PanelResponse } from "../lib/contract.ts";
import { publicCauseFailure } from "../lib/failures.ts";
import { classifyPanel, PanelResults } from "./panel-results.ts";
import { ConfiguredPanelResults } from "./configured-model.ts";

const encodeSuccess = Schema.encodeSync(Schema.toCodecJson(PanelResponse));
const encodeFailure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure));

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

const toHttpResponse = (exit: Exit.Exit<PanelResponse, ClassificationFailure>): Response =>
  Exit.match(exit, {
    onSuccess: (value) =>
      Response.json(encodeSuccess(value), {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }),
    onFailure: (cause) =>
      Option.match(publicCauseFailure(cause), {
        onNone: () => new Response(null, { status: 499, headers: { "Cache-Control": "no-store" } }),
        onSome: (failure) =>
          Response.json(encodeFailure(failure), {
            status: failureStatus(failure),
            headers: { "Cache-Control": "no-store" },
          }),
      }),
  });

/**
 * Bind HTTP classification to a supplied runtime. Reject malformed or excess request fields,
 * propagate request cancellation, and encode public success/failure payloads with no-store headers.
 * Interruption-only exits produce an empty 499 response.
 */
export const makeHandlers = (
  runtime: ManagedRuntime.ManagedRuntime<PanelResults, ClassificationFailure>,
) => ({
  classifyHttp: async (request: Request): Promise<Response> =>
    toHttpResponse(
      await runtime.runPromiseExit(classifyRequest(request), { signal: request.signal }),
    ),
});

const runtime = ManagedRuntime.make(
  ConfiguredPanelResults.pipe(Layer.provide(FetchHttpClient.layer)),
);
/** Configured classification handler; fixture/live selection and the cache belong to the module runtime. */
export const { classifyHttp } = makeHandlers(runtime);
