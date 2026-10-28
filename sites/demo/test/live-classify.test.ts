// @vitest-environment node
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { ConfigProvider, Layer, ManagedRuntime, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  ClassificationFailure,
  ClassificationReply,
  PublicModelReason,
} from "../src/lib/contract.ts";
import { makeHandlers } from "../src/server/classify.ts";
import { ConfiguredPanelResults } from "../src/server/configured-model.ts";

vi.mock("server-only", () => ({}));

const requestPanel = (panelId = "broad") =>
  new Request("http://localhost/api/classify", {
    method: "POST",
    body: JSON.stringify({ panelId }),
  });

const clefRequest = Schema.Struct({
  model: Schema.Literal("clef"),
  state: Schema.Struct({ records: Schema.Array(Schema.String), taxa: Schema.Array(Schema.String) }),
  questions: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.Literal("choice"),
      instructions: Schema.String,
      criteria: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});

const accountId = "0123456789abcdef0123456789abcdef";
const token = "offline-clef-token-never-use-for-authentication";
const liveConfig = {
  DEMO_MODEL: "clef",
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: token,
};

const configuredRuntime = (
  fetch: typeof globalThis.fetch,
  config: Readonly<Record<string, string>> = liveConfig,
) =>
  ManagedRuntime.make(
    ConfiguredPanelResults.pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
    ),
  );

const invalidConfigurations: ReadonlyArray<{
  name: string;
  config: Readonly<Record<string, string>>;
}> = [
  { name: "missing credentials", config: { DEMO_MODEL: "clef" } },
  {
    name: "invalid account ID",
    config: { ...liveConfig, CLOUDFLARE_ACCOUNT_ID: "SECRET invalid/account" },
  },
  { name: "empty token", config: { ...liveConfig, CLOUDFLARE_API_TOKEN: "" } },
  { name: "whitespace token", config: { ...liveConfig, CLOUDFLARE_API_TOKEN: "   " } },
  { name: "invalid mode", config: { ...liveConfig, DEMO_MODEL: "SECRET invalid mode" } },
];

it.each(invalidConfigurations)(
  "returns a safe configuration failure before transport: $name",
  async ({ config }) => {
    const fetch = vi.fn(() => Promise.reject(new Error("Provider access forbidden")));
    const runtime = configuredRuntime(fetch, config);
    try {
      const handlers = makeHandlers(runtime);
      const response = await handlers.classifyHttp(requestPanel());
      expect(response.status).toBe(503);
      const expected = Result.fail(ClassificationFailure.cases.ConfigurationFailure.make({}));
      const wire = await response.text();
      expect(wire).not.toContain(token);
      expect(wire).not.toContain("SECRET");
      expect(Schema.decodeUnknownSync(ClassificationReply)(JSON.parse(wire))).toEqual(expected);
      expect(Schema.decodeSync(ClassificationReply)(await handlers.initialReply())).toEqual(
        expected,
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  },
);

it("classifies through the live HTTP contract in serial bounded batches and shares cached replies", async () => {
  let active = 0;
  let maximumActive = 0;
  const questionCounts: Array<number> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      const request = new Request(input, init);
      expect(request.url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`,
      );
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
      const body = Schema.decodeUnknownSync(clefRequest)(await request.json());
      expect(body.state.records).toHaveLength(6);
      expect(JSON.stringify(body.state)).not.toContain(token);
      const questions = Object.entries(body.questions);
      questionCounts.push(questions.length);
      for (const [, question] of questions) {
        expect(Object.keys(question.criteria)).toEqual([
          "sameTaxon",
          "withinTaxon",
          "noMatch",
          "undetermined",
        ]);
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          model: "clef",
          answers: Object.fromEntries(
            questions.map(([key]) => [
              key,
              {
                type: "choice",
                choice: "noMatch",
                probabilities: {
                  sameTaxon: 0.01,
                  withinTaxon: 0.01,
                  noMatch: 0.95,
                  undetermined: 0.03,
                },
                confidence: 0.8,
              },
            ]),
          ),
          usage: { input_tokens: 123, output_tokens: 0 },
        },
      });
    } finally {
      active--;
    }
  });
  const runtime = configuredRuntime(fetch);
  try {
    const handlers = makeHandlers(runtime);
    const response = await handlers.classifyHttp(requestPanel());
    expect(response.status).toBe(200);
    const reply = Schema.decodeUnknownSync(ClassificationReply)(await response.json());
    expect(Result.isSuccess(reply)).toBe(true);
    if (Result.isSuccess(reply)) {
      expect(reply.success.rows).toHaveLength(24);
      expect(reply.success.rows[0]?.matches[0]).toMatchObject({
        targetId: "fungi",
        judgment: { _tag: "NotMatched" },
        support: 0.02,
        answer: { label: "noMatch", confidence: 0.8 },
      });
    }
    expect(questionCounts).toEqual([36, 36, 36, 36]);
    expect(Schema.decodeSync(ClassificationReply)(await handlers.initialReply())).toEqual(reply);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect((await handlers.classifyHttp(requestPanel("focused"))).status).toBe(200);
    expect(questionCounts).toEqual([36, 36, 36, 36, 60, 60, 60, 60]);
    expect((await handlers.classifyHttp(requestPanel())).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(maximumActive).toBe(1);
  } finally {
    await runtime.dispose();
  }
});

it("keeps fixture mode independent of live credentials and transport", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error("Provider forbidden")));
  const runtime = configuredRuntime(fetch, {
    DEMO_MODEL: "fixture",
    CLOUDFLARE_ACCOUNT_ID: "invalid",
    CLOUDFLARE_API_TOKEN: "",
  });
  try {
    expect((await makeHandlers(runtime).classifyHttp(requestPanel())).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});

it.each([
  { status: 400, reason: PublicModelReason.cases.InvalidRequestError.make({}), retryable: false },
  {
    status: 401,
    reason: PublicModelReason.cases.AuthenticationError.make({ kind: "InvalidKey" }),
    retryable: false,
  },
  {
    status: 403,
    reason: PublicModelReason.cases.AuthenticationError.make({ kind: "InsufficientPermissions" }),
    retryable: false,
  },
  { status: 429, reason: PublicModelReason.cases.RateLimitError.make({}), retryable: true },
  { status: 500, reason: PublicModelReason.cases.InternalProviderError.make({}), retryable: true },
])(
  "sanitizes Clef HTTP $status without automatically retrying",
  async ({ status, reason, retryable }) => {
    const fetch = vi.fn(async () =>
      Response.json(
        { success: false, errors: [{ message: `SECRET provider body ${token}` }] },
        { status },
      ),
    );
    const runtime = configuredRuntime(fetch);
    try {
      const response = await makeHandlers(runtime).classifyHttp(requestPanel());
      expect(response.status).toBe(503);
      const wire = await response.text();
      expect(wire).not.toContain("SECRET");
      expect(wire).not.toContain(token);
      expect(Schema.decodeUnknownSync(ClassificationReply)(JSON.parse(wire))).toEqual(
        Result.fail(ClassificationFailure.cases.ModelFailure.make({ reason, retryable })),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  },
);

it("sanitizes transport failures without retrying", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error(`SECRET transport ${token}`)));
  const runtime = configuredRuntime(fetch);
  try {
    const response = await makeHandlers(runtime).classifyHttp(requestPanel());
    expect(response.status).toBe(503);
    const wire = await response.text();
    expect(wire).not.toContain(token);
    expect(wire).not.toContain("SECRET");
    expect(Schema.decodeUnknownSync(ClassificationReply)(JSON.parse(wire))).toEqual(
      Result.fail(
        ClassificationFailure.cases.ModelFailure.make({
          reason: PublicModelReason.cases.NetworkError.make({}),
          retryable: true,
        }),
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.dispose();
  }
});

it("aborts the actual transport when the final HTTP waiter cancels", async () => {
  const started = Promise.withResolvers<void>();
  let aborts = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(
    (input, init) =>
      new Promise((_, reject) => {
        const { signal } = new Request(input, init);
        signal.addEventListener(
          "abort",
          () => {
            aborts++;
            reject(signal.reason);
          },
          { once: true },
        );
        started.resolve();
      }),
  );
  const runtime = configuredRuntime(fetch);
  try {
    const controller = new AbortController();
    const pending = makeHandlers(runtime).classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: JSON.stringify({ panelId: "broad" }),
        signal: controller.signal,
      }),
    );
    await started.promise;
    controller.abort(new Error("SECRET cancellation"));
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
    expect(aborts).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.dispose();
  }
});

it.each(["invalid JSON", "missing answers", "invalid probabilities"])(
  "rejects an invalid Clef success: %s",
  async (kind) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (kind === "invalid JSON") return new Response("SECRET not JSON", { status: 200 });
      const request = Schema.decodeUnknownSync(clefRequest)(await new Request(input, init).json());
      return Response.json({
        success: true,
        result: {
          model: "clef",
          usage: { input_tokens: 1, output_tokens: 0 },
          answers:
            kind === "missing answers"
              ? {}
              : Object.fromEntries(
                  Object.keys(request.questions).map((key) => [
                    key,
                    {
                      type: "choice",
                      choice: "noMatch",
                      confidence: 0.8,
                      probabilities: {
                        sameTaxon: 0.5,
                        withinTaxon: 0.5,
                        noMatch: 0.5,
                        undetermined: 0.5,
                      },
                    },
                  ]),
                ),
        },
      });
    });
    const runtime = configuredRuntime(fetch);
    try {
      const response = await makeHandlers(runtime).classifyHttp(requestPanel());
      expect(response.status).toBe(503);
      expect(Schema.decodeUnknownSync(ClassificationReply)(await response.json())).toEqual(
        Result.fail(
          ClassificationFailure.cases.ModelFailure.make({
            reason: PublicModelReason.cases.InvalidOutputError.make({}),
            retryable: true,
          }),
        ),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  },
);
