import { Effect, Exit, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { askClef, LocationQuestion, VerdictQuestion } from "../tools/review/clef.ts";

const credentials = { accountId: "test-account", token: Redacted.make("test-token") };

const state = { path: "test/example.test.ts", numberedSource: "1: expect(actual).toBe(expected);" };

const questions = [
  new VerdictQuestion({ id: "verdict", instructions: "Is there a violation?" }),
  new LocationQuestion({
    id: "location",
    instructions: "Where is the violation?",
    candidates: { line1: "Line 1", unclear: "No clear location" },
  }),
];

it.effect("pairs Clef answers with their questions in request order", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) => {
      expect(request.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/clef",
      );

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            success: true,
            result: {
              answers: {
                location: { type: "choice", choice: "line1", confidence: 0.9 },
                verdict: { type: "noul", noul: 0.8 },
              },
            },
          }),
        ),
      );
    });

    const answers = yield* askClef({ state, questions, credentials }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    expect(answers).toMatchObject([
      { id: "verdict", probability: 0.8 },
      { id: "location", choice: "line1" },
    ]);
  }),
);

it.effect("does not pass review when Clef omits a verdict", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ success: true, result: { answers: {} } }),
        ),
      ),
    );

    const exit = yield* askClef({ state, questions, credentials }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect("does not accept a location that was not offered", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            success: true,
            result: {
              answers: {
                verdict: { type: "noul", noul: 0.8 },
                location: { type: "choice", choice: "line999", confidence: 0.9 },
              },
            },
          }),
        ),
      ),
    );

    const exit = yield* askClef({ state, questions, credentials }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
  }),
);
