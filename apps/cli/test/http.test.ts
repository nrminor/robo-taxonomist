import { expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Match, Record, Ref, Schema } from "effect";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { TestClock } from "effect/testing";
import { RecordLabel, TaxonName, TaxonSet } from "robo-taxonomist";
import * as Api from "../src/api.ts";
import * as Documents from "../src/documents.ts";
import * as Model from "../src/model.ts";
import * as Server from "../src/server.ts";
import * as TestJson from "./Json.ts";

it.effect("checks HTTP record membership against an empty target without model inference", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["membership"]);
    const record = RecordLabel.make("Voucher A17");

    const result = yield* client.membership.check({
      payload: { record, target: Documents.SetDocument.cases.Empty.make({}) },
    });

    expect(result).toEqual(Documents.MembershipJudgment.cases.NotMember.make({}));
  }).pipe(
    Effect.provide([
      Server.membership().pipe(Layer.provide(fixtureProvider({})), Layer.provideMerge(bounds)),
      HttpServer.layerServices,
    ]),
  ),
);

it.effect("returns all five native HTTP partition buckets with repeated identifying records", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["membership"]);
    const record = Documents.RecordDocument.make({
      taxonId: { taxonomy: "ncbi", id: "123" },
      metadata: ["caller"],
    });

    const result = yield* client.membership.partition({
      payload: {
        records: [record, record],
        target: Documents.SetDocument.cases.Empty.make({}),
      },
    });

    expect(result).toEqual({
      Member: [],
      NotMember: [record, record],
      MixedMembership: [],
      Undetermined: [],
      MultipleTaxaInTarget: [],
    });
  }).pipe(
    Effect.provide([
      Server.membership().pipe(Layer.provide(fixtureProvider({})), Layer.provideMerge(bounds)),
      HttpServer.layerServices,
    ]),
  ),
);

it.effect.each([
  { quantifier: "all", tag: "Yes" },
  { quantifier: "any", tag: "No" },
  { quantifier: "none", tag: "Yes" },
] as const)("asks the native HTTP whole-collection question: $quantifier", ({ quantifier, tag }) =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["membership"]);
    const result = yield* client.membership[quantifier]({
      payload: { records: [], target: Documents.SetDocument.cases.Empty.make({}) },
    });

    expect(result).toEqual(Documents.QuantifierJudgment.cases[tag].make({ quantifier }));
  }).pipe(
    Effect.provide([
      Server.membership().pipe(Layer.provide(fixtureProvider({})), Layer.provideMerge(bounds)),
      HttpServer.layerServices,
    ]),
  ),
);

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
    Effect.gen(function* () {
      const body = yield* TestJson.encode(reply);
      const response = new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(Effect.orDie),
  );
  const configuration = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" }),
  );
  const transport = Layer.succeed(HttpClient.HttpClient, http);

  return Model.modelLayer("fixture-model").pipe(Layer.provide([configuration, transport]));
};

const bounds = Server.requestBounds();

it.effect(
  "bounds native HTTP classification batches while retaining repeated records, panel topology and stable ties",
  () =>
    Effect.gen(function* () {
      const firstWindow = yield* Deferred.make<void>();
      let calls = 0;
      let active = 0;
      let peak = 0;
      const questionCounts: number[] = [];
      const wireRequest = Schema.fromJsonString(
        Schema.Struct({ questions: Schema.Record(Schema.String, Schema.Unknown) }),
      );
      const http = HttpClient.make(
        Effect.fnUntraced(function* (request) {
          const text = Match.value(request.body).pipe(
            Match.tag("Uint8Array", ({ body }) => new TextDecoder().decode(body)),
            Match.orElse(() => {
              throw new Error("Expected a JSON provider request");
            }),
          );
          const payload = yield* Schema.decodeEffect(wireRequest)(text).pipe(Effect.orDie);
          const questionCount = Record.size(payload.questions);
          questionCounts.push(questionCount);
          calls++;
          active++;
          peak = Math.max(peak, active);
          if (calls === 2) yield* Deferred.succeed(firstWindow, undefined);
          yield* Deferred.await(firstWindow);
          const answers = Record.map(payload.questions, (_question, questionId) => {
            const choice = questionId.endsWith("t2")
              ? "noMatch"
              : questionId.endsWith("t3")
                ? "undetermined"
                : "withinTaxon";
            return {
              type: "choice",
              choice,
              confidence: 1,
              probabilities: {
                sameTaxon: 0,
                withinTaxon: 0,
                noMatch: 0,
                undetermined: 0,
                [choice]: 1,
              },
            };
          });
          const body = yield* TestJson.encode({
            model: "fixture-model",
            answers,
          }).pipe(Effect.orDie);
          const response = new Response(body, {
            headers: { "content-type": "application/json" },
          });
          active--;
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      const configuration = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" }),
      );
      const transport = Layer.succeed(HttpClient.HttpClient, http);
      const provider = Model.modelLayer("fixture-model").pipe(
        Layer.provide([configuration, transport]),
      );
      const handlers = Server.classification({
        maxRecords: 5,
        maxTargets: 5,
        maxRecordTargetPairs: 25,
        batchSize: 2,
        concurrency: 2,
      }).pipe(Layer.provide(provider), Layer.provideMerge(bounds));
      const first = Documents.RecordDocument.make({
        taxonId: { taxonomy: "ncbi", id: "123" },
        metadata: [null, true],
      });
      const records = [
        first,
        first,
        RecordLabel.make("B"),
        RecordLabel.make("C"),
        RecordLabel.make("D"),
      ];
      const oak = Documents.RecordDocument.make({
        scientificName: TaxonName.make("Quercus"),
        caller: "target",
      });
      const beech = Documents.RecordDocument.make({ scientificName: TaxonName.make("Fagus") });
      const birch = Documents.RecordDocument.make({ scientificName: TaxonName.make("Betula") });
      const leaf = Documents.SetDocument.cases.Taxon.make({ record: oak });
      const other = Documents.SetDocument.cases.Taxon.make({ record: beech });
      const birchLeaf = Documents.SetDocument.cases.Taxon.make({ record: birch });
      const left = Documents.SetDocument.cases.Union.make({
        operands: [leaf, leaf, other, birchLeaf],
      });
      const right = other;
      const panel = Documents.SetDocument.cases.Difference.make({ left, right });

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(Api.api, ["classification"]);
        return yield* client.classification.classify({ payload: { records, panel } });
      }).pipe(Effect.provide([handlers, HttpServer.layerServices]));

      expect(questionCounts).toEqual([8, 8, 4]);
      expect(peak).toBe(2);
      expect(calls).toBe(3);
      expect(result.panel).toEqual(panel);
      expect(result.records.map(({ record }) => record)).toEqual(records);
      expect(result.usage).toEqual([{}, {}, {}]);
      for (const row of result.records) {
        expect(row.taxa.map(({ judgment }) => judgment)).toEqual([
          { _tag: "WithinTaxon", support: 1 },
          { _tag: "WithinTaxon", support: 1 },
          { _tag: "NotMatched", support: 1 },
          { _tag: "Undetermined" },
        ]);
        expect(row.ranking).toEqual(row.taxa.slice(0, 2));
        expect(row.taxa.map(({ answer }) => answer.confidence)).toEqual([1, 1, 1, 1]);
      }
    }),
);

const membershipReply = (choices: readonly string[]) => ({
  model: "fixture-model",
  answers: Record.fromEntries(
    choices.map((choice, index) => [
      `record${index}`,
      {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: {
          member: 0,
          notMember: 0,
          mixed: 0,
          undetermined: 0,
          multipleTarget0: 0,
          [choice]: 1,
        },
      },
    ]),
  ),
});

it.effect.each([
  {
    records: [],
    panel: Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus") }),
    }),
  },
  {
    records: [RecordLabel.make("A"), RecordLabel.make("A")],
    panel: Documents.SetDocument.cases.Empty.make({}),
  },
] as const)(
  "preserves native empty classification framing over HTTP: $panel._tag",
  ({ records, panel }) => {
    const classificationHandlers = Server.classification().pipe(
      Layer.provide(fixtureProvider({})),
      Layer.provideMerge(bounds),
    );

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["classification"]);
      const result = yield* client.classification.classify({ payload: { records, panel } });

      expect(result).toEqual({
        panel,
        records: records.map((record) => ({ record, taxa: [], ranking: [] })),
        usage: [],
      });
    }).pipe(Effect.provide([classificationHandlers, HttpServer.layerServices]));
  },
);

it.effect(
  "preserves native partition outcomes, bucket order and clarification metadata over HTTP",
  () => {
    const replies = membershipReply([
      "member",
      "notMember",
      "mixed",
      "undetermined",
      "multipleTarget0",
      "member",
    ]);
    const membershipHandlers = Server.membership().pipe(
      Layer.provide(fixtureProvider(replies)),
      Layer.provideMerge(bounds),
    );

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["membership"]);
      const first = Documents.RecordDocument.make({
        label: RecordLabel.make("A"),
        metadata: [null, true],
      });
      const records = [
        first,
        RecordLabel.make("B"),
        RecordLabel.make("C"),
        RecordLabel.make("D"),
        RecordLabel.make("E"),
        first,
      ];
      const target = Documents.RecordDocument.make({
        taxonId: { taxonomy: "ncbi", id: "123", curator: "caller" },
      });

      const result = yield* client.membership.partition({ payload: { records, target } });

      const expectedTarget = Documents.SetDocument.cases.Taxon.make({ record: target });
      expect(result).toEqual({
        Member: [first, first],
        NotMember: ["B"],
        MixedMembership: ["C"],
        Undetermined: ["D"],
        MultipleTaxaInTarget: [{ record: "E", target: expectedTarget }],
      });
    }).pipe(Effect.provide([membershipHandlers, HttpServer.layerServices]));
  },
);

it.effect.each([
  { quantifier: "all", tag: "No" },
  { quantifier: "any", tag: "No" },
  { quantifier: "none", tag: "Yes" },
] as const)(
  "retains native whole-input mixed-membership semantics over HTTP: $quantifier",
  ({ quantifier, tag }) => {
    const membershipHandlers = Server.membership().pipe(
      Layer.provide(fixtureProvider(membershipReply(["mixed"]))),
      Layer.provideMerge(bounds),
    );

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["membership"]);
      const result = yield* client.membership[quantifier]({
        payload: {
          records: [RecordLabel.make("A")],
          target: TaxonName.make("Quercus"),
        },
      });

      expect(result).toEqual(Documents.QuantifierJudgment.cases[tag].make({ quantifier }));
    }).pipe(Effect.provide([membershipHandlers, HttpServer.layerServices]));
  },
);

it.effect(
  "does not bypass an earlier native target clarification for a later member over HTTP",
  () => {
    const membershipHandlers = Server.membership().pipe(
      Layer.provide(fixtureProvider(membershipReply(["multipleTarget0", "member"]))),
      Layer.provideMerge(bounds),
    );

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["membership"]);
      const target = TaxonName.make("Quercus");
      const result = yield* client.membership.any({
        payload: {
          records: [RecordLabel.make("A"), RecordLabel.make("B")],
          target,
        },
      });

      const expectedTarget = TaxonSet.of(target);
      const expected = Documents.QuantifierJudgment.cases.MultipleTaxaInTarget.make({
        quantifier: "any",
        target: expectedTarget,
      });
      expect(result).toEqual(expected);
    }).pipe(Effect.provide([membershipHandlers, HttpServer.layerServices]));
  },
);
const handlers = Server.comparisons.pipe(
  Layer.provide(fixtureProvider(identityReply)),
  Layer.provideMerge(bounds),
);
const setHandlers = Server.sets.pipe(
  Layer.provide(fixtureProvider(identityReply)),
  Layer.provideMerge(bounds),
);

it.effect(
  "returns the complete native HTTP classification including answers, ranking and usage",
  () => {
    const probabilities = { sameTaxon: 0.1, withinTaxon: 0.7, noMatch: 0.1, undetermined: 0.1 };
    const reply = {
      model: "fixture-model",
      answers: {
        r0t0: {
          type: "choice",
          choice: "withinTaxon",
          confidence: 0.91,
          probabilities,
        },
      },
      usage: { input_tokens: 7, output_tokens: 3 },
    };
    const classificationHandlers = Server.classification().pipe(
      Layer.provide(fixtureProvider(reply)),
      Layer.provideMerge(bounds),
    );

    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api.api, ["classification"]);
      const record = Documents.RecordDocument.make({
        taxonId: { taxonomy: "ncbi", id: "123" },
        metadata: [null, true],
      });
      const panel = Documents.RecordDocument.make({
        scientificName: TaxonName.make("Quercus"),
        caller: "panel",
      });
      const result = yield* client.classification.classify({
        payload: { records: [record], panel },
      });
      const taxon = Documents.SetDocument.cases.Taxon.make({ record: panel });
      const match = {
        record,
        taxon,
        judgment: { _tag: "WithinTaxon", support: 0.7 },
        answer: {
          label: "withinTaxon",
          probabilities,
          confidence: 0.91,
        },
      };

      expect(result).toEqual({
        panel: taxon,
        records: [{ record, taxa: [match], ranking: [match] }],
        usage: [{ inputTokens: 7, outputTokens: 3 }],
      });
    }).pipe(Effect.provide([classificationHandlers, HttpServer.layerServices]));
  },
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
    const left = Documents.RecordDocument.make({
      scientificName: TaxonName.make("Quercus"),
      metadata: { sample: "A17" },
    });
    const right = Documents.RecordDocument.make({
      label: RecordLabel.make("oak voucher"),
      metadata: { sample: "B42" },
    });

    const result = yield* client.comparisons.identity({ payload: { left, right } });

    expect(result).toEqual(Documents.IdentityJudgment.cases.Undetermined.make({}));
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

    expect(failure).toBeInstanceOf(Api.ModelFailure);
    expect(failure).toMatchObject({
      _tag: "ModelFailure",
      message: "The decision model request failed",
    });
    const serializedFailure = yield* TestJson.encode(failure);
    expect(serializedFailure).not.toContain(secret);
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

    expect(result).toEqual(Documents.ContainmentJudgment.cases.Contained.make({}));
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

      expect(result).toEqual(Documents.RankJudgment.cases.SameTaxonAtRank.make({ rank: "genus" }));
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

      const expectedOak = Documents.SetDocument.cases.Taxon.make({
        record: Documents.RecordDocument.make({ scientificName: name }),
      });
      const expectedVoucher = Documents.SetDocument.cases.Taxon.make({
        record: Documents.RecordDocument.make({
          label: RecordLabel.make("beech voucher"),
          metadata: { curator: "caller", abundance: 0.37 },
        }),
      });
      const expected = Documents.SetDocument.cases.Union.make({
        operands: [expectedOak, expectedVoucher, expectedOak],
      });
      expect(result).toEqual(expected);
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

    const expectedLeft = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: left }),
    });
    const expectedRight = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({
        label: RecordLabel.make("beech voucher"),
        metadata: ["caller"],
      }),
    });
    const expected = Documents.SetDocument.cases.Union.make({
      operands: [expectedLeft, expectedRight],
    });
    expect(result).toEqual(expected);
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

    const expectedLeft = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({
        label: RecordLabel.make("Voucher A17"),
        _tag: "Empty",
        metadata: ["caller"],
      }),
    });
    const expectedRight = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: right }),
    });
    const expected = Documents.SetDocument.cases.Union.make({
      operands: [expectedLeft, expectedRight],
    });
    expect(result).toEqual(expected);
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

    const expectedOak = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: oak }),
    });
    const expectedBeech = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: beech }),
    });
    const expectedLeft = Documents.SetDocument.cases.Union.make({
      operands: [expectedOak, expectedBeech],
    });
    const expectedRight = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: right }),
    });
    const expected = Documents.SetDocument.cases.Intersection.make({
      operands: [expectedLeft, expectedRight],
    });
    expect(result).toEqual(expected);
  }).pipe(Effect.provide([setHandlers, HttpServer.layerServices])),
);

it.effect("preserves left and right in a directed set difference", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(Api.api, ["sets"]);
    const left = TaxonName.make("Fagaceae");
    const right = TaxonName.make("Quercus");

    const result = yield* client.sets.difference({ payload: { left, right } });

    const expectedLeft = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: left }),
    });
    const expectedRight = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: right }),
    });
    const expected = Documents.SetDocument.cases.Difference.make({
      left: expectedLeft,
      right: expectedRight,
    });
    expect(result).toEqual(expected);
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

    expect(result).toEqual(Documents.SetRelationJudgment.cases.Yes.make({ relation: "subset" }));
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

    expect(result).toEqual(Documents.SetRelationJudgment.cases[tag].make({ relation }));
  }).pipe(Effect.provide([relationHandlers, HttpServer.layerServices]));
});

it.effect(
  "encodes the identifier-only target without extra metadata in a relation clarification",
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

      const expectedTaxon = TaxonSet.of(
        Documents.RecordDocument.make({
          taxonId: { taxonomy: "ncbi", id: "123", release: "2026" },
        }),
      );
      const expected = Documents.SetRelationJudgment.cases.MultipleTaxaInSet.make({
        relation: "overlap",
        side: "right",
        taxon: expectedTaxon,
      });
      expect(result).toEqual(expected);
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

      expect(failure).toBeInstanceOf(Api.RequestTooLarge);
      expect(failure).toMatchObject({ _tag: "RequestTooLarge", maxBodyBytes: 32 });
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
    expect(failure).toBeInstanceOf(Api.RequestDeadline);
    expect(failure).toMatchObject({ _tag: "RequestDeadline", timeoutMs: 10 });
  }),
);
