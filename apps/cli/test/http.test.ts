import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Ref } from "effect";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { TestClock } from "effect/testing";
import { RecordLabel, TaxonName } from "robo-taxonomist";
import * as Api from "../src/api.ts";
import * as Documents from "../src/documents.ts";
import * as Model from "../src/model.ts";
import * as Server from "../src/server.ts";

const identityReply = {
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
};

const subsetReply = {
  model: "fixture-model",
  answers: {
    relation: {
      type: "choice",
      choice: "properSubset",
      confidence: 1,
      probabilities: {
        equal: 0,
        properSubset: 1,
        properSuperset: 0,
        partialOverlap: 0,
        disjoint: 0,
        bothEmpty: 0,
        leftEmpty: 0,
        rightEmpty: 0,
        undetermined: 0,
        multipleLeft0: 0,
        multipleRight0: 0,
      },
    },
  },
};

const fixtureProvider = (reply: unknown, status = 200) => {
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = JSON.stringify(reply);
      const response = new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const configuration = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" }),
  );
  const transport = Layer.succeed(HttpClient.HttpClient, http);

  return Model.modelLayer("fixture-model").pipe(Layer.provide([configuration, transport]));
};

const bounds = Server.requestBounds();
const handlers = Server.comparisons.pipe(
  Layer.provide(fixtureProvider(identityReply)),
  Layer.provideMerge(bounds),
);
const setHandlers = Server.sets.pipe(
  Layer.provide(fixtureProvider(identityReply)),
  Layer.provideMerge(bounds),
);

it.effect("compares exact labels through the generated HTTP client and request codecs", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["comparisons"]);
    const left = RecordLabel.make("Voucher A17");
    const right = RecordLabel.make("Voucher A17");

    const result = yield* client.comparisons.labels({ payload: { left, right } });

    expect(result).toBe(true);
  }).pipe(Effect.provide([handlers, HttpServer.layerServices])),
);

it.effect("returns a native unresolved identity judgment as a successful HTTP response", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["comparisons"]);
    const left = { scientificName: TaxonName.make("Quercus"), metadata: { sample: "A17" } };
    const right = { label: RecordLabel.make("oak voucher"), metadata: { sample: "B42" } };

    const result = yield* client.comparisons.identity({ payload: { left, right } });

    expect(result).toEqual({ _tag: "Undetermined" });
  }).pipe(Effect.provide([handlers, HttpServer.layerServices])),
);

it.effect("returns a typed provider failure without exposing provider content", () => {
  const secret = "fixture-private-provider-content";
  const provider = fixtureProvider({ error: { message: secret } }, 401);
  const failingHandlers = Server.comparisons.pipe(
    Layer.provide(provider),
    Layer.provideMerge(bounds),
  );

  return Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["comparisons"]);
    const left = TaxonName.make("Quercus");
    const right = TaxonName.make("Fagus");

    const failure = yield* client.comparisons
      .identity({ payload: { left, right } })
      .pipe(Effect.flip);

    expect(failure).toEqual({ _tag: "ModelFailure", message: "The decision model request failed" });
    expect(JSON.stringify(failure)).not.toContain(secret);
  }).pipe(Effect.provide([failingHandlers, HttpServer.layerServices]));
});

it.effect("answers directed inner-to-outer containment through the HTTP contract", () => {
  const reply = {
    model: "fixture-model",
    answers: {
      containment: {
        type: "choice",
        choice: "properSubset",
        confidence: 1,
        probabilities: {
          equal: 0,
          properSubset: 1,
          properSuperset: 0,
          partialOverlap: 0,
          disjoint: 0,
          bothEmpty: 0,
          leftEmpty: 0,
          rightEmpty: 0,
          undetermined: 0,
          multipleLeft: 0,
          multipleRight: 0,
          multipleBoth: 0,
        },
      },
    },
  };
  const provider = fixtureProvider(reply);
  const containmentHandlers = Server.comparisons.pipe(
    Layer.provide(provider),
    Layer.provideMerge(bounds),
  );

  return Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["comparisons"]);
    const inner = TaxonName.make("Quercus");
    const outer = TaxonName.make("Fagaceae");

    const result = yield* client.comparisons.containment({ payload: { inner, outer } });

    expect(result).toEqual({ _tag: "Contained" });
  }).pipe(Effect.provide([containmentHandlers, HttpServer.layerServices]));
});

it.effect(
  "takes taxonomic rank as an explicit query option and retains it in the native answer",
  () => {
    const reply = {
      model: "fixture-model",
      answers: {
        comparison: {
          type: "choice",
          choice: "equalSingle",
          confidence: 1,
          probabilities: {
            equalSingle: 1,
            equalMultiple: 0,
            properSubset: 0,
            properSuperset: 0,
            partialOverlap: 0,
            disjoint: 0,
            undetermined: 0,
            multipleLeft: 0,
            multipleRight: 0,
            multipleBoth: 0,
          },
        },
      },
    };
    const provider = fixtureProvider(reply);
    const rankHandlers = Server.comparisons.pipe(
      Layer.provide(provider),
      Layer.provideMerge(bounds),
    );

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["comparisons"]);
      const left = RecordLabel.make("Voucher A17");
      const right = RecordLabel.make("Voucher B42");

      const result = yield* client.comparisons.rank({
        payload: { left, right },
        query: { rank: "genus" },
      });

      expect(result).toEqual({ _tag: "SameTaxonAtRank", rank: "genus" });
    }).pipe(Effect.provide([rankHandlers, HttpServer.layerServices]));
  },
);

it.effect(
  "creates a reusable symbolic set from names and identifying records without losing metadata",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
      const name = TaxonName.make("Quercus");
      const record = Documents.RecordDocument.make({
        label: RecordLabel.make("beech voucher"),
        metadata: { curator: "caller", abundance: 0.37 },
      });

      const result = yield* client.sets.create({ payload: { targets: [name, record, name] } });

      expect(result).toEqual({
        _tag: "Union",
        operands: [
          { _tag: "Taxon", record: { scientificName: "Quercus" } },
          {
            _tag: "Taxon",
            record: { label: "beech voucher", metadata: { curator: "caller", abundance: 0.37 } },
          },
          { _tag: "Taxon", record: { scientificName: "Quercus" } },
        ],
      });
    }).pipe(Effect.provide([setHandlers, HttpServer.layerServices])),
);

it.effect("unions two HTTP operands without requiring a generated artifact for literal names", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
    const left = TaxonName.make("Quercus");
    const right = Documents.RecordDocument.make({
      label: RecordLabel.make("beech voucher"),
      metadata: ["caller"],
    });

    const result = yield* client.sets.union({ payload: { left, right } });

    expect(result).toEqual({
      _tag: "Union",
      operands: [
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
        { _tag: "Taxon", record: { label: "beech voucher", metadata: ["caller"] } },
      ],
    });
  }).pipe(Effect.provide([setHandlers, HttpServer.layerServices])),
);

it.effect("does not mistake a record's caller-supplied tag metadata for a set expression", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
    const left = Documents.RecordDocument.make({
      label: RecordLabel.make("Voucher A17"),
      _tag: "Empty",
      metadata: ["caller"],
    });
    const right = TaxonName.make("Quercus");

    const result = yield* client.sets.union({ payload: { left, right } });

    expect(result).toEqual({
      _tag: "Union",
      operands: [
        { _tag: "Taxon", record: { label: "Voucher A17", _tag: "Empty", metadata: ["caller"] } },
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
      ],
    });
  }).pipe(Effect.provide([setHandlers, HttpServer.layerServices])),
);

it.effect("intersects operands while preserving supplied artifact topology", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
    const oak = TaxonName.make("Quercus");
    const beech = TaxonName.make("Fagus");
    const left = yield* client.sets.create({ payload: { targets: [oak, beech] } });
    const right = TaxonName.make("Fagaceae");

    const result = yield* client.sets.intersection({ payload: { left, right } });

    expect(result).toEqual({
      _tag: "Intersection",
      operands: [
        {
          _tag: "Union",
          operands: [
            { _tag: "Taxon", record: { scientificName: "Quercus" } },
            { _tag: "Taxon", record: { scientificName: "Fagus" } },
          ],
        },
        { _tag: "Taxon", record: { scientificName: "Fagaceae" } },
      ],
    });
  }).pipe(Effect.provide([setHandlers, HttpServer.layerServices])),
);

it.effect("preserves left and right in a directed set difference", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
    const left = TaxonName.make("Fagaceae");
    const right = TaxonName.make("Quercus");

    const result = yield* client.sets.difference({ payload: { left, right } });

    expect(result).toEqual({
      _tag: "Difference",
      left: { _tag: "Taxon", record: { scientificName: "Fagaceae" } },
      right: { _tag: "Taxon", record: { scientificName: "Quercus" } },
    });
  }).pipe(Effect.provide([setHandlers, HttpServer.layerServices])),
);

it.effect("asks a native set relation using a query option and directed operand data", () => {
  const provider = fixtureProvider(subsetReply);
  const relationHandlers = Server.sets.pipe(Layer.provide(provider), Layer.provideMerge(bounds));

  return Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
    const left = TaxonName.make("Quercus");
    const right = TaxonName.make("Fagaceae");

    const result = yield* client.sets.relation({
      payload: { left, right },
      query: { relation: "subset" },
    });

    expect(result).toEqual({ _tag: "Yes", relation: "subset" });
  }).pipe(Effect.provide([relationHandlers, HttpServer.layerServices]));
});

it.effect.each([
  { relation: "subset", tag: "Yes" },
  { relation: "proper-subset", tag: "Yes" },
  { relation: "equivalent", tag: "No" },
  { relation: "overlap", tag: "Yes" },
  { relation: "disjoint", tag: "No" },
] as const)("dispatches the requested native set question: $relation", ({ relation, tag }) => {
  const provider = fixtureProvider(subsetReply);
  const relationHandlers = Server.sets.pipe(Layer.provide(provider), Layer.provideMerge(bounds));

  return Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
    const left = TaxonName.make("Quercus");
    const right = TaxonName.make("Fagaceae");

    const result = yield* client.sets.relation({ payload: { left, right }, query: { relation } });

    expect(result).toEqual({ _tag: tag, relation });
  }).pipe(Effect.provide([relationHandlers, HttpServer.layerServices]));
});

it.effect(
  "retains the complete identifier-only target and metadata in a relation clarification",
  () => {
    const probabilities = {
      ...subsetReply.answers.relation.probabilities,
      properSubset: 0,
      multipleRight0: 1,
    };
    const reply = {
      model: "fixture-model",
      answers: {
        relation: {
          type: "choice",
          choice: "multipleRight0",
          confidence: 1,
          probabilities,
        },
      },
    };
    const provider = fixtureProvider(reply);
    const relationHandlers = Server.sets.pipe(Layer.provide(provider), Layer.provideMerge(bounds));

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
      const left = TaxonName.make("Quercus");
      const right = Documents.RecordDocument.make({
        taxonId: { taxonomy: "ncbi", id: "123", release: "2026", curator: "caller" },
        metadata: { sample: ["A17", null] },
      });

      const result = yield* client.sets.relation({
        payload: { left, right },
        query: { relation: "overlap" },
      });

      expect(result).toEqual({
        _tag: "MultipleTaxaInSet",
        relation: "overlap",
        side: "right",
        taxon: {
          _tag: "Taxon",
          record: {
            taxonId: { taxonomy: "ncbi", id: "123", release: "2026", curator: "caller" },
            metadata: { sample: ["A17", null] },
          },
        },
      });
    }).pipe(Effect.provide([relationHandlers, HttpServer.layerServices]));
  },
);

it.effect(
  "rejects an oversized request body with a typed limit error before executing the endpoint",
  () => {
    const limits = Server.requestBounds({ maxBodyBytes: 32, timeoutMs: 60_000, maxJsonDepth: 64 });
    const boundedHandlers = Server.comparisons.pipe(
      Layer.provide(fixtureProvider(identityReply)),
      Layer.provideMerge(limits),
    );

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["comparisons"]);
      const left = RecordLabel.make("A".repeat(100));
      const right = RecordLabel.make("A".repeat(100));

      const failure = yield* client.comparisons
        .labels({ payload: { left, right } })
        .pipe(Effect.flip);

      expect(failure).toEqual({ _tag: "RequestTooLarge", maxBodyBytes: 32 });
    }).pipe(Effect.provide([boundedHandlers, HttpServer.layerServices]));
  },
);

it.effect("interrupts the provider request at the HTTP deadline and returns a typed timeout", () =>
  Effect.gen(function* () {
    const interrupted = yield* Ref.make(false);
    const pending = Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true)));
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => pending),
    );
    const configuration = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" }),
    );
    const provider = Model.modelLayer("fixture-model").pipe(
      Layer.provide([configuration, transport]),
    );
    const limits = Server.requestBounds({
      maxBodyBytes: 1_048_576,
      timeoutMs: 10,
      maxJsonDepth: 64,
    });
    const timedHandlers = Server.comparisons.pipe(
      Layer.provide(provider),
      Layer.provideMerge(limits),
    );

    const request = Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["comparisons"]);
      const left = TaxonName.make("Quercus");
      const right = TaxonName.make("Fagus");

      return yield* client.comparisons.identity({ payload: { left, right } }).pipe(Effect.flip);
    }).pipe(Effect.provide([timedHandlers, HttpServer.layerServices]));

    const fiber = yield* Effect.forkChild(request);
    yield* TestClock.adjust(20);
    const wasInterrupted = yield* Ref.get(interrupted);

    expect(wasInterrupted).toBe(true);

    const failure = yield* Fiber.join(fiber);
    expect(failure).toEqual({ _tag: "RequestDeadline", timeoutMs: 10 });
  }),
);
