import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { AiError } from "effect/ai";
import { CliError } from "effect/cli";
import { Errors } from "robo-taxonomist";
import * as Model from "../src/model.ts";

it.effect("retains input and provider causes while exposing safe distinct guidance", () =>
  Effect.gen(function* () {
    const schemaCause = yield* Schema.decodeUnknownEffect(Schema.Finite)("private input").pipe(
      Effect.flip,
    );
    const invalid = new Errors.InvalidInput({ cause: schemaCause });
    const input = Model.cliFailure(invalid);
    expect(input.cause).toBe(invalid);
    expect(input.userMessage).toContain("identifying fields");
    expect(input.userMessage).not.toContain("private input");

    const provider = new AiError.AiError({
      module: "fixture",
      method: "decide",
      reason: new AiError.AuthenticationError({
        kind: "InvalidKey",
        description: "private secret",
      }),
    });
    const authentication = Model.cliFailure(provider);
    expect(authentication.cause).toBe(provider);
    expect(authentication.userMessage).toContain("authentication");
    expect(authentication.userMessage).not.toContain("private secret");

    const rateLimit = new AiError.AiError({
      module: "fixture",
      method: "decide",
      reason: new AiError.RateLimitError({}),
    });
    expect(Model.cliFailure(rateLimit).userMessage).toContain("rate-limiting");
    const existing = new CliError.UserError({ cause: "existing cause", userMessage: "existing" });
    expect(Model.cliFailure(existing)).toBe(existing);
  }),
);

it("gives safe guidance for unusable answers and invalid user input", () => {
  const secret = "private provider details";
  const reasons = [
    new AiError.InvalidOutputError({ description: secret }),
    new AiError.InvalidResponseError({ description: secret }),
    new AiError.StructuredOutputError({ description: secret, responseText: secret }),
    new AiError.InvalidUserInputError({ description: secret }),
  ];
  for (const reason of reasons) {
    const provider = new AiError.AiError({ module: "fixture", method: "decide", reason });
    const failure = Model.cliFailure(provider);
    expect(failure.cause).toBe(provider);
    expect(failure.userMessage).toContain(
      reason._tag === "InvalidUserInputError" ? "input" : "unusable answer",
    );
    expect(failure.userMessage).not.toContain(secret);
  }
});
