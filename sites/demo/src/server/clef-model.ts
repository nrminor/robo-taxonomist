import "server-only";
import { Data, Effect, Layer, Redacted, Schema } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const tokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
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

const invalidOutput = () =>
  AiError.make({
    module: "ClefModel",
    method: "decide",
    reason: new AiError.InvalidOutputError({
      description: "Clef returned an invalid response",
    }),
  });

const httpError = (error: HttpClientError.HttpClientError): AiError.AiError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError": {
      const network = AiError.NetworkError.fromRequestError(reason);
      return AiError.make({
        module: "ClefModel",
        method: "decide",
        reason: new AiError.NetworkError({
          reason: network.reason,
          request: { ...network.request, headers: {} },
          description: "Clef HTTP request failed",
        }),
      });
    }
    case "StatusCodeError":
      return AiError.make({
        module: "ClefModel",
        method: "decide",
        reason: AiError.reasonFromHttpStatus({ status: reason.response.status }),
      });
    default:
      return invalidOutput();
  }
};

export function clefModelLayer(options: {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted<string>;
}): Layer.Layer<DecisionModel.DecisionModel, never, HttpClient.HttpClient> {
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
          if (decision._tag !== "Classify") {
            return yield* AiError.make({
              module: "ClefModel",
              method: "decide",
              reason: new AiError.InvalidRequestError({
                description: "This Clef adapter supports only Classify decisions",
              }),
            });
          }
          questions[key] = {
            type: "choice",
            instructions: decision.instructions,
            criteria: decision.criteria,
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
        const response = yield* client.execute(request).pipe(Effect.mapError(httpError));
        if (response.status < 200 || response.status >= 300) {
          return yield* AiError.make({
            module: "ClefModel",
            method: "decide",
            reason: AiError.reasonFromHttpStatus({ status: response.status }),
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
}
