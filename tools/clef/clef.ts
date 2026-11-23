import { Data, Duration, Effect, HashMap, Match, Schema, type Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class VerdictQuestion extends Schema.TaggedClass<
  VerdictQuestion,
  { readonly brand: unique symbol }
>()("Verdict", {
  id: Schema.String,
  instructions: Schema.String,
}) {}

export class LocationQuestion extends Schema.TaggedClass<
  LocationQuestion,
  { readonly brand: unique symbol }
>()("Location", {
  id: Schema.String,
  instructions: Schema.String,
  candidates: Schema.Record(Schema.String, Schema.String),
}) {}

const Question = Schema.Union([VerdictQuestion, LocationQuestion]);

const Batch = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ answers: Schema.Record(Schema.String, Schema.Unknown) }),
});

const VerdictAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

const LocationAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: VerdictAnswer.fields.noul,
});

class InvalidClefBatch extends Data.TaggedError("InvalidClefBatch")<{
  readonly message: string;
}> {}

const encodeQuestion = Match.type<typeof Question.Type>().pipe(
  Match.tagsExhaustive({
    Verdict: ({ instructions }) => ({ type: "noul", instructions }),
    Location: ({ instructions, candidates }) => ({
      type: "choice",
      instructions,
      criteria: candidates,
    }),
  }),
);

const decodeAnswer = Effect.fnUntraced(function* (
  question: typeof Question.Type,
  answers: HashMap.HashMap<string, unknown>,
) {
  const answer = yield* HashMap.get(answers, question.id).pipe(
    Effect.fromOption(
      () => new InvalidClefBatch({ message: `Missing Clef answer: ${question.id}` }),
    ),
  );

  return yield* Match.value(question).pipe(
    Match.tagsExhaustive({
      Verdict: ({ id }) =>
        Schema.decodeUnknownEffect(VerdictAnswer)(answer).pipe(
          Effect.map(({ noul }) => ({ id, probability: noul })),
        ),
      Location: ({ id, candidates }) => {
        const expected = HashMap.fromIterable(Object.entries(candidates));

        const schema = LocationAnswer.check(
          Schema.makeFilter(({ choice }) => HashMap.has(expected, choice)),
        );

        return Schema.decodeUnknownEffect(schema)(answer).pipe(
          Effect.map(({ choice, confidence }) => ({ id, choice, confidence })),
        );
      },
    }),
  );
});

export const askClef = Effect.fn("Review.askClef")(
  function* (input: {
    readonly state: { readonly path: string; readonly numberedSource: string };
    readonly questions: ReadonlyArray<typeof Question.Type>;
    readonly credentials: { readonly accountId: string; readonly token: Redacted.Redacted<string> };
  }) {
    const { state, questions, credentials } = input;

    if (questions.length === 0 || questions.length > 64) {
      return yield* new InvalidClefBatch({ message: "Clef expects 1–64 questions" });
    }

    const entries = new Map(questions.map((question) => [question.id, encodeQuestion(question)]));

    if (entries.size !== questions.length) {
      return yield* new InvalidClefBatch({ message: "Clef question IDs must be unique" });
    }

    const client = yield* HttpClient.HttpClient;
    const account = encodeURIComponent(credentials.accountId);
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef`;
    const body = { model: "clef", state, questions: Object.fromEntries(entries) };

    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bearerToken(credentials.token),
      HttpClientRequest.bodyJson(body),
    );

    const response = yield* HttpClient.filterStatusOk(client).execute(request);
    const json = yield* response.json;
    const { result } = yield* Schema.decodeUnknownEffect(Batch)(json);
    const answers = HashMap.fromIterable(Object.entries(result.answers));

    return yield* Effect.forEach(questions, (question) => decodeAnswer(question, answers));
  },
  Effect.timeout(Duration.seconds(30)),
);

export const askClefLive = (input: Parameters<typeof askClef>[0]) =>
  askClef(input).pipe(Effect.provide(FetchHttpClient.layer));
