import "server-only";
import { Effect, Exit, Layer, ManagedRuntime, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import { ClassificationFailure, ClassifyRequest, PanelResponse } from "../lib/contract.ts";
import { ClassificationFailureWithCause, publicCauseFailure } from "../lib/failures.ts";
import { classifyPanel, PanelResults } from "./panel-results.ts";
import { ConfiguredPanelResults } from "./configured-model.ts";

const encodeSuccess = Schema.encodeSync(Schema.toCodecJson(PanelResponse));

const encodeFailure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure));

const requestEnvelope = Schema.Struct({
  ...ClassifyRequest.fields,
  hints: Schema.optional(Schema.Unknown),
});

const failureStatus = (failure: ClassificationFailure): number =>
  ClassificationFailure.match(failure, {
    InvalidPanel: () => 400,
    InvalidHints: () => 400,
    ModelFailure: () => 503,
    ConfigurationFailure: () => 503,
    InternalFailure: () => 500,
  });

const decodeEnvelope = Schema.decodeUnknownEffect(requestEnvelope, {
  onExcessProperty: "error",
});

// Decode the parsed value strictly: the JSON codec treats null optional fields as absent.
const readEnvelope = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.json),
  Effect.flatMap(decodeEnvelope),
  Effect.mapError(
    (cause) =>
      new ClassificationFailureWithCause({
        failure: ClassificationFailure.cases.InvalidPanel.make({}),
        cause: Redacted.make(cause),
      }),
  ),
);

/** Classify the current HTTP request while preserving distinct envelope and hint failures. */
export const classifyRequest = Effect.gen(function* () {
  const envelope = yield* readEnvelope;

  const input = yield* Schema.decodeUnknownEffect(ClassifyRequest)(envelope).pipe(
    Effect.mapError(
      (cause) =>
        new ClassificationFailureWithCause({
          failure: ClassificationFailure.cases.InvalidHints.make({}),
          cause: Redacted.make(cause),
        }),
    ),
  );

  return yield* classifyPanel(input.panelId, input.refresh, input.hints);
}).pipe(Effect.withSpan("classifyRequest"));

const toHttpResponse = (
  exit: Exit.Exit<PanelResponse, Effect.Error<typeof classifyRequest> | ClassificationFailure>,
): Response =>
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
  runtime: ManagedRuntime.ManagedRuntime<
    PanelResults,
    ClassificationFailure | ClassificationFailureWithCause
  >,
) => ({
  classifyHttp: async (request: Request): Promise<Response> => {
    const program = classifyRequest.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
    );

    const exit = await runtime.runPromiseExit(program, { signal: request.signal });

    return toHttpResponse(exit);
  },
});

const runtime = ManagedRuntime.make(
  ConfiguredPanelResults.pipe(Layer.provide(FetchHttpClient.layer)),
);

/** Configured classification handler; fixture/live selection and the cache belong to the module runtime. */
export const { classifyHttp } = makeHandlers(runtime);
