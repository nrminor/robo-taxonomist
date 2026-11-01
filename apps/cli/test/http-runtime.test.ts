import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Logger, Match, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { RecordLabel, TaxonName } from "robo-taxonomist";
import * as Api from "../src/api.ts";
import * as Model from "../src/model.ts";
import * as Server from "../src/server.ts";

const providerRequest = Schema.fromJsonString(Schema.Struct({ model: Schema.String }));

const providerHttp = HttpClient.make((request) =>
  Effect.sync(() => {
    const payload = Match.value(request.body).pipe(
      Match.tagsExhaustive({
        Uint8Array: ({ body }) => new TextDecoder().decode(body),
        Empty: () => "",
        Raw: () => "",
        FormData: () => "",
        Stream: () => "",
      }),
    );
    const decoded = Schema.decodeUnknownSync(providerRequest)(payload);

    expect(decoded.model).toBe("fixture-model");
    expect(request.headers.authorization).toBe("Bearer fixture-key");

    const body = JSON.stringify({
      model: "fixture-model",
      answers: {
        identity: {
          type: "choice",
          choice: "undetermined",
          confidence: 1,
          probabilities: {
            same: 0,
            different: 0,
            undetermined: 1,
            multipleLeft: 0,
            multipleRight: 0,
            multipleBoth: 0,
          },
        },
      },
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    return HttpClientResponse.fromWeb(request, response);
  }),
);
const configuration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" }),
);
const transport = Layer.succeed(HttpClient.HttpClient, providerHttp);
const provider = Model.modelLayer("fixture-model").pipe(Layer.provide([configuration, transport]));
const options = Server.Options.make({
  host: "127.0.0.1",
  port: 0,
  maxBodyBytes: 1_048_576,
  timeoutMs: 60_000,
  maxJsonDepth: 64,
});
const running = Server.layer(options).pipe(Layer.provide(provider));

it.effect("rejects deeply nested set expressions before the recursive endpoint schema runs", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const baseUrl = HttpServer.formatAddress(server.address);
    const depth = 4096;
    const left =
      '{"_tag":"Difference","left":'.repeat(depth) +
      '{"_tag":"Empty"}' +
      ',"right":{"_tag":"Empty"}}'.repeat(depth);
    const body = `{"left":${left},"right":"Quercus"}`;
    const request = HttpClientRequest.post(`${baseUrl}/sets/union`).pipe(
      HttpClientRequest.bodyText(body, "application/json"),
    );

    const response = yield* HttpClient.execute(request);
    const failure = yield* response.json;

    expect(response.status).toBe(400);
    expect(failure).toEqual({ _tag: "RequestTooDeep", maxJsonDepth: 64 });
  }).pipe(Effect.provide([running, FetchHttpClient.layer])),
);

it.effect.each([
  { containers: 64, status: 200, maxJsonDepth: 64 },
  { containers: 65, status: 400, maxJsonDepth: 64 },
  { containers: 4096, status: 400, maxJsonDepth: 64 },
  { containers: 4, status: 400, maxJsonDepth: 3 },
])(
  "bounds parsed JSON container depth before recursive decoding: $containers",
  ({ containers, status, maxJsonDepth }) =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const baseUrl = HttpServer.formatAddress(server.address);
      const metadata = "[".repeat(containers - 3) + "null" + "]".repeat(containers - 3);
      const body = `{"targets":[{"scientificName":"Quercus","metadata":${metadata}}]}`;
      const request = HttpClientRequest.post(`${baseUrl}/sets/create`).pipe(
        HttpClientRequest.bodyText(body, "application/json; charset=utf-8"),
      );

      const response = yield* HttpClient.execute(request);

      expect(response.status).toBe(status);
      if (status === 400) {
        const failure = yield* response.json;
        expect(failure).toEqual({ _tag: "RequestTooDeep", maxJsonDepth });
      }
    }).pipe(
      Effect.provide([
        Server.layer({ ...options, maxJsonDepth }).pipe(Layer.provide(provider)),
        FetchHttpClient.layer,
      ]),
    ),
);

it.effect("allows large flat inputs and ignores bracket characters inside JSON strings", () => {
  const bounded = Server.layer({ ...options, maxJsonDepth: 3 }).pipe(Layer.provide(provider));

  return Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const baseUrl = HttpServer.formatAddress(server.address);
    const client = yield* HttpApiClient.make(Api.api, { baseUrl });
    const target = TaxonName.make('Quercus [\\"' + "[]{}".repeat(100));
    const targets = Array.from({ length: 1000 }, () => target);

    const result = yield* client.sets.create({ payload: { targets } });

    expect(result).toEqual({
      _tag: "Union",
      operands: targets.map((scientificName) => ({
        _tag: "Taxon",
        record: { scientificName },
      })),
    });
  }).pipe(Effect.provide([bounded, FetchHttpClient.layer]));
});

it.effect("leaves unsupported content types to the HTTP API decoder", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const baseUrl = HttpServer.formatAddress(server.address);
    const body = "[".repeat(100) + "null" + "]".repeat(100);
    const request = HttpClientRequest.post(`${baseUrl}/sets/create`).pipe(
      HttpClientRequest.bodyText(body, "text/plain"),
    );

    const response = yield* HttpClient.execute(request);

    expect(response.status).toBe(415);
  }).pipe(Effect.provide([running, FetchHttpClient.layer])),
);

it.effect("serves pure and model-backed requests over a real loopback socket", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const baseUrl = HttpServer.formatAddress(server.address);
    const client = yield* HttpApiClient.make(Api.api, { baseUrl });
    const label = RecordLabel.make("Voucher A17");
    const left = TaxonName.make("Quercus");
    const right = TaxonName.make("Fagus");

    const equality = yield* client.comparisons.labels({ payload: { left: label, right: label } });
    const identity = yield* client.comparisons.identity({ payload: { left, right } });

    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(equality).toBe(true);
    expect(identity).toEqual({ _tag: "Undetermined" });
  }).pipe(
    Effect.provide([running, FetchHttpClient.layer]),
    Effect.provideService(Logger.LogToStderr, true),
  ),
);

it.effect("serves generated OpenAPI and Scalar documents from the same running contract", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const baseUrl = HttpServer.formatAddress(server.address);
    const specificationResponse = yield* HttpClient.get(`${baseUrl}/openapi.json`);
    const specificationSchema = Schema.Struct({
      paths: Schema.Record(Schema.String, Schema.Unknown),
    });
    const specification =
      yield* HttpClientResponse.schemaBodyJson(specificationSchema)(specificationResponse);
    const documentationResponse = yield* HttpClient.get(`${baseUrl}/docs`);
    const documentation = yield* documentationResponse.text;

    expect(specificationResponse.status).toBe(200);
    expect(Object.keys(specification.paths)).toEqual(
      expect.arrayContaining([
        "/compare/labels",
        "/compare/identity",
        "/compare/rank",
        "/compare/containment",
        "/sets/create",
        "/sets/union",
        "/sets/intersection",
        "/sets/difference",
        "/sets/relation",
      ]),
    );
    expect(documentationResponse.status).toBe(200);
    expect(documentationResponse.headers["content-type"]).toContain("text/html");
    expect(documentation).toContain("/compare/identity");
  }).pipe(Effect.provide([running, FetchHttpClient.layer])),
);

it.effect("rejects malformed JSON over the actual socket without turning it into a judgment", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const baseUrl = HttpServer.formatAddress(server.address);
    const request = HttpClientRequest.post(`${baseUrl}/compare/labels`).pipe(
      HttpClientRequest.bodyText("{not JSON", "application/json"),
    );

    const response = yield* HttpClient.execute(request);

    expect(response.status).toBe(400);
  }).pipe(Effect.provide([running, FetchHttpClient.layer])),
);

it.effect(
  "keeps provider configuration fixed when a request supplies model or credential fields",
  () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const baseUrl = HttpServer.formatAddress(server.address);
      const endpoint = HttpClientRequest.post(
        `${baseUrl}/compare/identity?model=request-model&apiKey=request-key`,
      );
      const request = yield* HttpClientRequest.bodyJson(endpoint, {
        left: "Quercus",
        right: "Fagus",
        model: "request-model",
        apiKey: "request-key",
      });

      const response = yield* HttpClient.execute(request);
      const result = yield* response.json;

      expect(response.status).toBe(200);
      expect(result).toEqual({ _tag: "Undetermined" });
    }).pipe(Effect.provide([running, FetchHttpClient.layer])),
);

it.effect(
  "enforces the body-byte limit on chunked requests without a content-length header",
  () => {
    const bounded = Server.layer({ ...options, maxBodyBytes: 64 }).pipe(Layer.provide(provider));

    return Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const baseUrl = HttpServer.formatAddress(server.address);
      const text = JSON.stringify({ left: "A".repeat(100), right: "B".repeat(100) });
      const bytes = new TextEncoder().encode(text);
      const body = Stream.make(bytes.subarray(0, 32), bytes.subarray(32));
      const request = HttpClientRequest.post(`${baseUrl}/compare/labels`).pipe(
        HttpClientRequest.bodyStream(body, { contentType: "application/json" }),
      );

      const response = yield* HttpClient.execute(request);
      const failure = yield* response.json;

      expect(response.status).toBe(413);
      expect(failure).toEqual({ _tag: "RequestTooLarge", maxBodyBytes: 64 });
    }).pipe(Effect.provide([bounded, FetchHttpClient.layer]));
  },
);
