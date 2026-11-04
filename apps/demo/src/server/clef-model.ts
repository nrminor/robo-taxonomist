import "server-only";
import { Clock, Data, Effect, Layer, Match, Option, Redacted, Result, Schema } from "effect";
import { AiError, DecisionModel, type Decision } from "effect/ai";
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const tokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const classifyQuestionSchema = Schema.Struct({
  instructions: Schema.String,
  criteria: Schema.Record(Schema.String, Schema.String),
});
const responseSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    model: Schema.String,
    answers: Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.Literal("choice"),
        choice: Schema.String,
        probabilities: Schema.Record(Schema.String, probability),
        confidence: probability,
      }),
    ),
    usage: Schema.Struct({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
    }),
  }),
});
const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();
const Decisions = Data.taggedEnum<Decision.Any>();

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

/**
 * Live Cloudflare Clef adapter requiring an HTTP client and server-side credentials.
 * Accepts 1–64 Classify decisions per call; validates response shape, [0, 1] probabilities and
 * nonnegative integer token counts. Response decoding alone does not enforce probability normalization.
 */
export const clefModelLayer = (options: {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted<string>;
}): Layer.Layer<DecisionModel.DecisionModel, never, HttpClient.HttpClient> => {
  return Layer.effect(
    DecisionModel.DecisionModel,
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
        const entries = Object.entries(decisions);
        if (entries.length === 0 || entries.length > 64) {
          return yield* AiError.make({
            module: "ClefModel",
            method: "decide",
            reason: new AiError.InvalidRequestError({
              description: "Clef requires between 1 and 64 questions",
            }),
          });
        }
        const questions: Record<
          string,
          {
            readonly type: "choice";
            readonly instructions: string;
            readonly criteria: Readonly<Record<string, string>>;
          }
        > = Object.create(null);
        for (const [key, decision] of entries) {
          if (!Decisions.$is("Classify")(decision)) {
            return yield* AiError.make({
              module: "ClefModel",
              method: "decide",
              reason: new AiError.InvalidRequestError({
                description: "This Clef adapter supports only Classify decisions",
              }),
            });
          }
          const question = yield* Schema.decodeUnknownEffect(classifyQuestionSchema)(decision).pipe(
            Effect.mapError(() =>
              AiError.make({
                module: "ClefModel",
                method: "decide",
                reason: new AiError.InvalidRequestError({
                  description: "This Clef adapter requires string instructions and criteria",
                }),
              }),
            ),
          );
          questions[key] = {
            type: "choice",
            instructions: question.instructions,
            criteria: question.criteria,
          };
        }
        const request = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(options.apiToken),
          HttpClientRequest.bodyJson({ model: "clef", state, questions }),
          Effect.mapError(() =>
            AiError.make({
              module: "ClefModel",
              method: "decide",
              reason: new AiError.InvalidRequestError({
                description: "Could not encode the Clef request as JSON",
              }),
            }),
          ),
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
        const answers: Record<string, DecisionModel.ProviderClassifyAnswer> = Object.create(null);
        for (const [key, answer] of Object.entries(decoded.result.answers)) {
          answers[key] = Classify({
            label: answer.choice,
            probabilities: answer.probabilities,
            confidence: answer.confidence,
          });
        }
        return {
          answers,
          usage: {
            inputTokens: decoded.result.usage.input_tokens,
            outputTokens: decoded.result.usage.output_tokens,
          },
        };
      });
      return yield* DecisionModel.make({ decide });
    }),
  );
};
