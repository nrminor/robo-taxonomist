import "server-only";
import {
  Array,
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Equal,
  Function,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Predicate,
  Record,
  Redacted,
  Result,
  Schema,
  SchemaTransformation,
} from "effect";
import { AiError, DecisionModel, type Decision } from "effect/ai";
import {
  Headers,
  type HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const tokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const questionFields = {
  instructions: Schema.String,
  criteria: Schema.Record(Schema.String, Schema.String),
};

const ProviderQuestion = Schema.TaggedStruct("Classify", questionFields);

const ClefQuestionWire = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: questionFields.instructions,
  criteria: questionFields.criteria,
});

const ClefQuestion = ClefQuestionWire.pipe(
  Schema.decodeTo(
    ProviderQuestion,
    SchemaTransformation.transform({
      decode: ({ instructions, criteria }) => ProviderQuestion.make({ instructions, criteria }),
      encode: ({ instructions, criteria }) =>
        ClefQuestionWire.make({ type: "choice", instructions, criteria }),
    }),
  ),
);

const ClefRequest = Schema.Struct({
  model: Schema.Literal("clef"),
  state: Schema.Json,
  questions: Schema.Record(Schema.String, ClefQuestion),
});

const encodeClefRequest = Schema.encodeUnknownEffect(ClefRequest);

const isInvalidQuestion = Predicate.not(Schema.is(ProviderQuestion));

const probabilities = Schema.Record(Schema.String, probability);

const ClefChoice = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities,
  confidence: probability,
});

const ClassifyAnswer = Schema.TaggedStruct("Classify", {
  label: Schema.String,
  probabilities,
  confidence: probability,
});

const ClefAnswer = ClefChoice.pipe(
  Schema.decodeTo(
    ClassifyAnswer,
    SchemaTransformation.transform({
      decode: ({ choice, probabilities, confidence }) =>
        ClassifyAnswer.make({ label: choice, probabilities, confidence }),
      encode: ({ label, probabilities, confidence }) =>
        ClefChoice.make({ type: "choice", choice: label, probabilities, confidence }),
    }),
  ),
);

const responseSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    model: Schema.String,
    answers: Schema.Unknown,
    usage: Schema.Struct({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
    }),
  }),
});

const Decisions = Data.taggedEnum<Decision.Any>();

const isUnsupportedDecision = Predicate.not(Decisions.$is("Classify"));

/** Original request-construction failure, retained only on the internal Effect cause. */
export class ClefRequestCause extends Context.Service<
  ClefRequestCause,
  Cause.Cause<Schema.SchemaError | HttpBody.HttpBodyError>
>()("demo/ClefRequestCause") {}

const invalidRequest = (description: string) =>
  AiError.make({
    module: "ClefModel",
    method: "decide",
    reason: new AiError.InvalidRequestError({ description }),
  });

const mapInvalidRequest = (description: string) =>
  Effect.catchCause((cause: Cause.Cause<Schema.SchemaError | HttpBody.HttpBodyError>) => {
    const annotated = Cause.annotate(
      Cause.map(cause, () => invalidRequest(description)),
      Context.make(ClefRequestCause, cause),
    );

    return Effect.failCause(annotated);
  });

const invalidOutput = () =>
  AiError.make({
    module: "ClefModel",
    method: "decide",
    reason: new AiError.InvalidOutputError({
      description: "Clef returned an invalid response",
    }),
  });

const httpReason = (
  response: HttpClientResponse.HttpClientResponse,
  now: number,
): AiError.AiErrorReason => {
  const http = { response: { status: response.status, headers: response.headers } };
  const reason = AiError.reasonFromHttpStatus({ status: response.status, http });

  return Match.value(reason).pipe(
    Match.tags({
      RateLimitError: (rateLimit) => {
        const header = Headers.get(response.headers, "retry-after");

        const parsedHeader = Option.flatMap(header, (value) => {
          const parsed = Headers.parseRetryAfter(value);

          return Result.getSuccess(parsed);
        });

        return Option.match(parsedHeader, {
          onNone: () => rateLimit,
          onSome: (value) => {
            const retryAfter = Headers.retryAfterDelay(value, now);

            return new AiError.RateLimitError({
              http: rateLimit.http,
              metadata: rateLimit.metadata,
              retryAfter,
            });
          },
        });
      },
    }),
    Match.orElse((reason) => reason),
  );
};

const httpError = (error: HttpClientError.HttpClientError, now: number): AiError.AiError =>
  Match.value(error.reason).pipe(
    Match.tag("TransportError", "EncodeError", "InvalidUrlError", (requestError) => {
      const network = AiError.NetworkError.fromRequestError(requestError);

      const reason = new AiError.NetworkError({
        reason: network.reason,
        method: network.method,
        url: network.url,
        description: "Clef HTTP request failed",
      });

      return AiError.make({
        module: "ClefModel",
        method: "decide",
        reason,
      });
    }),
    Match.tagsExhaustive({
      StatusCodeError: (statusError) => {
        const reason = httpReason(statusError.response, now);

        return AiError.make({
          module: "ClefModel",
          method: "decide",
          reason,
        });
      },
      DecodeError: invalidOutput,
      EmptyBodyError: invalidOutput,
    }),
  );

type ClefOptions = {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted<string>;
};

const buildClefModel = (options: ClefOptions) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/@cf/cloudflare/clef`;

    const decide = Effect.fn("ClefModel.decide")(function* ({
      state,
      decisions,
    }: DecisionModel.ProviderOptions): Effect.fn.Return<
      DecisionModel.ProviderResponse,
      AiError.AiError
    > {
      const requestedIds = HashSet.fromIterable(Record.keys(decisions));
      const questionCount = HashSet.size(requestedIds);

      if (questionCount === 0 || questionCount > 64) {
        return yield* invalidRequest("Clef requires between 1 and 64 questions");
      }

      const requestBody = yield* encodeClefRequest({
        model: "clef",
        state,
        questions: decisions,
      }).pipe(
        Effect.catch((error) => {
          const firstInvalid = Array.findFirst(Record.values(decisions), isInvalidQuestion);
          const unsupported = Option.filter(firstInvalid, isUnsupportedDecision);

          return Option.match(unsupported, {
            onNone: () =>
              Effect.fail(error).pipe(
                mapInvalidRequest("This Clef adapter requires string instructions and criteria"),
              ),
            onSome: () =>
              Effect.fail(invalidRequest("This Clef adapter supports only Classify decisions")),
          });
        }),
      );

      const request = yield* HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(options.apiToken),
        HttpClientRequest.bodyJson(requestBody),
        mapInvalidRequest("Could not encode the Clef request as JSON"),
      );

      const clock = yield* Clock.Clock;

      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((error) => httpError(error, clock.currentTimeMillisUnsafe())));

      if (response.status < 200 || response.status >= 300) {
        const now = yield* Clock.currentTimeMillis;

        return yield* AiError.make({
          module: "ClefModel",
          method: "decide",
          reason: httpReason(response, now),
        });
      }

      const body = yield* response.json.pipe(Effect.mapError(invalidOutput));

      const decoded = yield* Schema.decodeUnknownEffect(responseSchema)(body).pipe(
        Effect.mapError(invalidOutput),
      );

      const candidate = Option.liftPredicate(decoded.result.answers, Predicate.isReadonlyObject);
      const wire = yield* Effect.fromOption(candidate, invalidOutput);
      const wireEntries = Record.toEntries(wire);

      const answerEntries = yield* Effect.forEach(wireEntries, ([id, value]) =>
        Schema.decodeUnknownEffect(ClefAnswer)(value).pipe(
          Effect.mapBoth({
            onSuccess: (answer) => [id, answer] as const,
            onFailure: invalidOutput,
          }),
        ),
      );

      const received = HashMap.fromIterable(answerEntries);
      const receivedIds = HashSet.fromIterable(HashMap.keys(received));

      const complete = yield* Effect.filterOrFail(
        Effect.succeed(received),
        () => Equal.equals(requestedIds, receivedIds),
        invalidOutput,
      );

      const answers = Record.fromIterableWith(HashMap.entries(complete), Function.identity);

      return {
        answers,
        usage: {
          inputTokens: decoded.result.usage.input_tokens,
          outputTokens: decoded.result.usage.output_tokens,
        },
      };
    });

    return yield* DecisionModel.make({ decide });
  });

/**
 * Live Cloudflare Clef adapter requiring an HTTP client and server-side credentials.
 * Accepts 1–64 Classify decisions per call. The reply must answer every submitted
 * decision and no others. Probabilities must be in [0, 1] and token counts must
 * be nonnegative integers. The decision model checks probability normalization.
 */
export const clefModelLayer = (
  options: ClefOptions,
): Layer.Layer<DecisionModel.DecisionModel, never, HttpClient.HttpClient> =>
  Layer.effect(DecisionModel.DecisionModel, buildClefModel(options));
