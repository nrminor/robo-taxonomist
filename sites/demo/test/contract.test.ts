import { expect, it } from "@effect/vitest";
import { Cause, DateTime, Duration, Option, Result, Schema } from "effect";
import { AiError } from "effect/ai";
import {
  ClassificationFailure,
  ClassificationReply,
  PublicModelReason,
} from "../src/lib/contract.ts";
import { publicModelFailure, publicCauseFailure } from "../src/lib/failures.ts";

it("round trips safe failures through the JSON result contract", () => {
  const failure = ClassificationFailure.cases.InvalidPanel.make({});
  const encoded = Schema.encodeSync(ClassificationReply)(Result.fail(failure));
  expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
  expect(Schema.decodeSync(ClassificationReply)(encoded)).toEqual(Result.fail(failure));
});

it("retains all 18 upstream failure categories while allowlisting their fields", () => {
  const secret = "SECRET provider content";
  const request = {
    method: "POST" as const,
    url: secret,
    urlParams: [],
    headers: { authorization: secret },
  };
  const reasons: readonly AiError.AiErrorReason[] = [
    new AiError.RateLimitError({
      retryAfter: Duration.millis(1200),
      metadata: { secret },
      http: { request, body: secret },
    }),
    new AiError.QuotaExhaustedError({
      resetAt: DateTime.makeUnsafe("2026-10-29T00:00:00Z"),
      metadata: { secret },
    }),
    new AiError.AuthenticationError({
      kind: "InvalidKey",
      description: secret,
      metadata: { secret },
      http: { request },
    }),
    new AiError.ContentPolicyError({ description: secret }),
    new AiError.InvalidRequestError({ description: secret, parameter: secret, constraint: secret }),
    new AiError.InternalProviderError({ description: secret }),
    new AiError.NetworkError({ reason: "TransportError", request, description: secret }),
    new AiError.InvalidOutputError({ description: secret }),
    new AiError.StructuredOutputError({ description: secret, responseText: secret }),
    new AiError.UnsupportedSchemaError({ description: secret }),
    new AiError.UnknownError({ description: secret }),
    new AiError.ToolNotFoundError({ toolName: secret, availableTools: [secret] }),
    new AiError.ToolParameterValidationError({ toolName: secret, description: secret }),
    new AiError.InvalidToolResultError({ toolName: secret, description: secret }),
    new AiError.ToolResultEncodingError({
      toolName: secret,
      toolResult: { secret },
      description: secret,
    }),
    new AiError.ToolConfigurationError({ toolName: secret, description: secret }),
    new AiError.ToolkitRequiredError({ pendingApprovals: [secret], description: secret }),
    new AiError.InvalidUserInputError({ description: secret }),
  ];
  expect(new Set(reasons.map((reason) => reason._tag)).size).toBe(18);
  for (const reason of reasons) {
    const failure = publicModelFailure(
      new AiError.AiError({ module: secret, method: secret, reason }),
    );
    expect(failure._tag).toBe("ModelFailure");
    if (failure._tag !== "ModelFailure") throw new Error("Expected model failure");
    expect(failure.reason._tag).toBe(reason._tag);
    expect(failure.retryable).toBe(reason.isRetryable);
    if (failure.reason._tag === "AuthenticationError")
      expect(failure.reason.kind).toBe("InvalidKey");
    if (failure.reason._tag === "QuotaExhaustedError") {
      expect(failure.reason.resetAt).toEqual(DateTime.makeUnsafe("2026-10-29T00:00:00Z"));
    }
    const encoded = Schema.encodeSync(ClassificationReply)(Result.fail(failure));
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    expect(JSON.stringify(encoded)).not.toContain("SECRET");
    expect(
      Schema.decodeUnknownSync(ClassificationReply)(JSON.parse(JSON.stringify(encoded))),
    ).toEqual(Result.fail(failure));
  }
});

it("rejects invalid retry delays and malformed replies at the boundary", () => {
  expect(() => Schema.decodeSync(ClassificationReply)({ unexpected: true })).toThrow();
  expect(() =>
    Schema.decodeSync(PublicModelReason)({ _tag: "RateLimitError", retryAfterMs: -1 }),
  ).toThrow();
  expect(() =>
    Schema.decodeSync(PublicModelReason)({ _tag: "RateLimitError", retryAfterMs: Infinity }),
  ).toThrow();
});

it("projects retry guidance without leaking provider descriptions or causes", () => {
  const error = new AiError.AiError({
    module: "secret module",
    method: "secret method",
    reason: new AiError.RateLimitError({
      metadata: { body: "SECRET provider body" },
      retryAfter: Duration.seconds(2),
    }),
  });
  const failure = publicModelFailure(error);
  expect(failure).toEqual(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({ retryAfterMs: 2000 }),
      retryable: true,
    }),
  );
  expect(
    JSON.stringify(Schema.encodeSync(ClassificationReply)(Result.fail(failure))),
  ).not.toContain("SECRET");
  expect(publicCauseFailure(Cause.interrupt(1))).toEqual(Option.none());
  expect(publicCauseFailure(Cause.die("SECRET"))).toEqual(
    Option.some(ClassificationFailure.cases.InternalFailure.make({})),
  );
});

it("does not disguise a mixed defect as a retryable model failure", () => {
  const error = new AiError.AiError({
    module: "SECRET module",
    method: "decide",
    reason: new AiError.RateLimitError({}),
  });
  const cause = Cause.combine(Cause.fail(error), Cause.die("SECRET defect"));
  expect(publicCauseFailure(cause)).toEqual(
    Option.some(ClassificationFailure.cases.InternalFailure.make({})),
  );
});

it("preserves known failures alongside interruption and hides unknown typed errors", () => {
  const failure = ClassificationFailure.cases.ConfigurationFailure.make({ requestId: "demo-42" });
  const modelError = new AiError.AiError({
    module: "fixture",
    method: "decide",
    reason: new AiError.RateLimitError({}),
  });
  expect(publicCauseFailure(Cause.combine(Cause.fail(failure), Cause.interrupt(1)))).toEqual(
    Option.some(failure),
  );
  expect(publicCauseFailure(Cause.fail(modelError))).toEqual(
    Option.some(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({}),
        retryable: true,
      }),
    ),
  );
  expect(publicCauseFailure(Cause.fail({ body: "SECRET unknown failure" }))).toEqual(
    Option.some(ClassificationFailure.cases.InternalFailure.make({})),
  );
});

it("omits unusable provider retry guidance but retains an immediate retry", () => {
  for (const retryAfter of [undefined, Duration.millis(-1), Duration.infinity]) {
    expect(
      publicModelFailure(
        new AiError.AiError({
          module: "fixture",
          method: "decide",
          reason: new AiError.RateLimitError({ retryAfter }),
        }),
      ),
    ).toEqual(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({}),
        retryable: true,
      }),
    );
  }
  expect(
    publicModelFailure(
      new AiError.AiError({
        module: "fixture",
        method: "decide",
        reason: new AiError.RateLimitError({ retryAfter: Duration.zero }),
      }),
    ),
  ).toEqual(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({ retryAfterMs: 0 }),
      retryable: true,
    }),
  );
});
