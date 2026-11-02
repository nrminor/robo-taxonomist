// @vitest-environment node
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Array, ConfigProvider, Layer, ManagedRuntime, Option, Record, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  ClassificationFailure,
  MatchJudgment,
  PanelResponse,
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
  state: Schema.Struct({
    records: Schema.Array(Schema.String),
    taxa: Schema.Array(Schema.Struct({ scientificName: Schema.String })),
  }),
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
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const expected = ClassificationFailure.cases.ConfigurationFailure.make({});
      const wire = await response.text();
      expect(wire).not.toContain(token);
      expect(wire).not.toContain("SECRET");
      expect(
        Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(JSON.parse(wire)),
      ).toEqual(expected);
      const repeated = await handlers.classifyHttp(requestPanel());
      expect(repeated.status).toBe(503);
      expect(
        Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(await repeated.json()),
      ).toEqual(expected);
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
      const questions = body.questions;
      questionCounts.push(Record.size(questions));
      for (const question of Record.values(questions)) {
        const criterionNames = Record.keys(question.criteria);
        expect(criterionNames).toEqual(["sameTaxon", "withinTaxon", "noMatch", "undetermined"]);
      }
      const answers = Record.map(questions, () => ({
        type: "choice",
        choice: "noMatch",
        probabilities: {
          sameTaxon: 0.01,
          withinTaxon: 0.01,
          noMatch: 0.95,
          undetermined: 0.03,
        },
        confidence: 0.8,
      }));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          model: "clef",
          answers,
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
    const reply = Schema.decodeUnknownSync(Schema.toCodecJson(PanelResponse))(
      await response.json(),
    );
    expect(reply.rows).toHaveLength(24);
    const row = Array.findFirst(reply.rows, (row) => row.recordId === "r01").pipe(
      Option.getOrThrow,
    );
    const match = Array.findFirst(row.matches, (match) => match.targetId === "fungi").pipe(
      Option.getOrThrow,
    );
    expect(match).toMatchObject({
      targetId: "fungi",
      judgment: MatchJudgment.cases.NotMatched.make({}),
      support: 0.02,
      answer: { label: "noMatch", confidence: 0.8 },
    });
    expect(questionCounts).toEqual([36, 36, 36, 36]);
    const cached = await handlers.classifyHttp(requestPanel());
    expect(cached.status).toBe(200);
    expect(cached.headers.get("Cache-Control")).toBe("no-store");
    const cachedReply = Schema.decodeUnknownSync(Schema.toCodecJson(PanelResponse))(
      await cached.json(),
    );
    expect(cachedReply).toEqual(reply);
    expect(fetch).toHaveBeenCalledTimes(4);
    const focused = await handlers.classifyHttp(requestPanel("focused"));
    expect(focused.status).toBe(200);
    expect(questionCounts).toEqual([36, 36, 36, 36, 60, 60, 60, 60]);
    const cachedBroad = await handlers.classifyHttp(requestPanel());
    expect(cachedBroad.status).toBe(200);
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
    const response = await makeHandlers(runtime).classifyHttp(requestPanel());
    expect(response.status).toBe(200);
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
      const failure = Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(
        JSON.parse(wire),
      );
      const expected = ClassificationFailure.cases.ModelFailure.make({ reason, retryable });
      expect(failure).toEqual(expected);
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
    const failure = Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(
      JSON.parse(wire),
    );
    const expected = ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.NetworkError.make({}),
      retryable: true,
    });
    expect(failure).toEqual(expected);
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
    const body = await response.text();
    expect(body).toBe("");
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
      const answers =
        kind === "missing answers"
          ? {}
          : Record.map(request.questions, () => ({
              type: "choice",
              choice: "noMatch",
              confidence: 0.8,
              probabilities: {
                sameTaxon: 0.5,
                withinTaxon: 0.5,
                noMatch: 0.5,
                undetermined: 0.5,
              },
            }));
      return Response.json({
        success: true,
        result: {
          model: "clef",
          usage: { input_tokens: 1, output_tokens: 0 },
          answers,
        },
      });
    });
    const runtime = configuredRuntime(fetch);
    try {
      const response = await makeHandlers(runtime).classifyHttp(requestPanel());
      expect(response.status).toBe(503);
      const failure = Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(
        await response.json(),
      );
      const expected = ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.InvalidOutputError.make({}),
        retryable: true,
      });
      expect(failure).toEqual(expected);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  },
);
