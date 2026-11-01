import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Match, Result, Schema } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestConsole } from "effect/testing";
import { cli } from "../src/cli.ts";

const wireRequest = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    state: Schema.Json,
    questions: Schema.Record(Schema.String, Schema.Json),
  }),
);

const identityReply = {
  model: "fixture-model",
  answers: {
    identity: {
      type: "choice",
      choice: "same",
      confidence: 1,
      probabilities: {
        same: 1,
        different: 0,
        undetermined: 0,
        multipleLeft: 0,
        multipleRight: 0,
        multipleBoth: 0,
      },
    },
  },
};

const relationProbabilities = {
  equal: 0,
  properSubset: 0,
  properSuperset: 0,
  partialOverlap: 0,
  disjoint: 0,
  bothEmpty: 0,
  leftEmpty: 0,
  rightEmpty: 0,
  undetermined: 0,
};

const invoke = Effect.fn("ComparisonTest.invoke")(
  function* (
    args: readonly string[],
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly reply?: unknown;
      readonly status?: number;
    } = {},
  ) {
    const requests: Array<typeof wireRequest.Type> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = Match.value(request.body).pipe(
          Match.tag("Uint8Array", ({ body }) =>
            Schema.decodeUnknownSync(wireRequest)(new TextDecoder().decode(body)),
          ),
          Match.orElse(() => {
            throw new Error("Expected a JSON provider request");
          }),
        );
        requests.push(body);
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(options.reply ?? identityReply), {
            status: options.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
    const outcome = yield* Command.runWith(cli, { version: "test" })(args).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown(options.env ?? { TYPESAFE_API_KEY: "fixture-key" }),
        ),
      ),
      Effect.result,
    );
    return {
      outcome,
      stdout: yield* TestConsole.logLines,
      stderr: yield* TestConsole.errorLines,
      requests,
    };
  },
  Effect.provide([NodeServices.layer, Layer.fresh(TestConsole.layer)]),
);

it.effect("compares identity through the configured TypeSafe protocol", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "compare",
      "identity",
      "Quercus robur",
      "English oak",
      "--model",
      "custom/model",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["judgment\tside", "SameTaxon\t"]);
    expect(result.stderr).toEqual([]);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.model).toBe("custom/model");
  }),
);

it.effect.each([401, 403, 429, 500])(
  "reports provider failure without leaking credentials or response content (%s)",
  (status) =>
    Effect.gen(function* () {
      const secret = "fixture-private-key-and-provider-content";
      const result = yield* invoke(
        ["compare", "identity", "Quercus", "Fagus", "--model", "custom/model"],
        {
          env: { TYPESAFE_API_KEY: secret },
          status,
          reply: { error: { message: secret } },
        },
      );
      expect(Result.isFailure(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toHaveLength(1);
      expect(JSON.stringify(result.stderr)).toContain("decision model request failed");
      expect(JSON.stringify(result.stderr)).not.toContain(secret);
    }),
);

it.effect("emits the complete native identity judgment as JSON", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "compare",
      "identity",
      "Quercus",
      "Fagus",
      "--model",
      "custom/model",
      "--format",
      "json",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(['{"_tag":"SameTaxon"}']);
    expect(result.stderr).toEqual([]);
  }),
);

it.effect("omits the comparison TSV header when requested", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "cmp",
      "identity",
      "Quercus",
      "Fagus",
      "--model",
      "custom/model",
      "--no-header",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["SameTaxon\t"]);
  }),
);

it.effect.each([
  { choice: "different", row: "DifferentTaxa\t", native: { _tag: "DifferentTaxa" } },
  { choice: "undetermined", row: "Undetermined\t", native: { _tag: "Undetermined" } },
  {
    choice: "multipleLeft",
    row: "MultipleTaxa\tleft",
    native: { _tag: "MultipleTaxa", side: "left" },
  },
  {
    choice: "multipleRight",
    row: "MultipleTaxa\tright",
    native: { _tag: "MultipleTaxa", side: "right" },
  },
  {
    choice: "multipleBoth",
    row: "MultipleTaxa\tboth",
    native: { _tag: "MultipleTaxa", side: "both" },
  },
])(
  "retains native identity outcomes without turning them into failures: $choice",
  ({ choice, row, native }) =>
    Effect.gen(function* () {
      const reply = {
        ...identityReply,
        answers: {
          identity: {
            ...identityReply.answers.identity,
            choice,
            probabilities: {
              ...identityReply.answers.identity.probabilities,
              same: 0,
              [choice]: 1,
            },
          },
        },
      };
      const args = ["compare", "identity", "Quercus", "Fagus", "--model", "custom/model"];
      const text = yield* invoke(args, { reply });
      expect(Result.isSuccess(text.outcome)).toBe(true);
      expect(text.stdout).toEqual(["judgment\tside", row]);
      const json = yield* invoke([...args, "--format", "json"], { reply });
      expect(Result.isSuccess(json.outcome)).toBe(true);
      expect(json.stdout).toEqual([JSON.stringify(native)]);
    }),
);

it.effect.each([
  { flags: ["--model", "custom/flag"], configured: "custom/environment", expected: "custom/flag" },
  { flags: [], configured: "custom/environment", expected: "custom/environment" },
  { flags: ["--model", "custom/flag"], configured: "   ", expected: "custom/flag" },
])(
  "selects a custom model with explicit flags taking precedence: $expected",
  ({ flags, configured, expected }) =>
    Effect.gen(function* () {
      const result = yield* invoke(["compare", "identity", "Quercus", "Fagus", ...flags], {
        env: { TYPESAFE_API_KEY: "fixture-key", ROBO_TAXONOMIST_MODEL: configured },
      });
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.model).toBe(expected);
    }),
);

it.effect.each([
  { flags: ["--model", "   "], configured: "custom/environment" },
  { flags: [], configured: "   " },
  { flags: [], configured: undefined },
])(
  "rejects invalid or absent model configuration without a provider call: $flags",
  ({ flags, configured }) =>
    Effect.gen(function* () {
      const env =
        configured === undefined
          ? { TYPESAFE_API_KEY: "fixture-key" }
          : { TYPESAFE_API_KEY: "fixture-key", ROBO_TAXONOMIST_MODEL: configured };
      const result = yield* invoke(["compare", "identity", "Quercus", "Fagus", ...flags], { env });
      expect(Result.isFailure(result.outcome)).toBe(true);
      expect(result.requests).toEqual([]);
    }),
);

it.effect("compares containment with directed inner and outer operands", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      ["compare", "containment", "Quercus", "Fagaceae", "--model", "custom/model"],
      {
        reply: {
          model: "fixture-model",
          answers: {
            containment: {
              type: "choice",
              choice: "properSubset",
              confidence: 1,
              probabilities: {
                ...relationProbabilities,
                properSubset: 1,
                multipleLeft: 0,
                multipleRight: 0,
                multipleBoth: 0,
              },
            },
          },
        },
      },
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["judgment\tside", "Contained\t"]);
    expect(result.requests[0]?.questions.containment).toMatchObject({
      instructions: expect.stringContaining('Left (inner) taxon:\nScientific name: "Quercus"'),
    });
    expect(result.requests[0]?.questions.containment).toMatchObject({
      instructions: expect.stringContaining('Right (outer) taxon:\nScientific name: "Fagaceae"'),
    });
  }),
);

const rankProbabilities = {
  equalSingle: 0,
  equalMultiple: 0,
  properSubset: 0,
  properSuperset: 0,
  partialOverlap: 0,
  disjoint: 0,
  undetermined: 0,
  multipleLeft: 0,
  multipleRight: 0,
  multipleBoth: 0,
};

it.effect("compares two record labels at the explicitly requested rank", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      [
        "compare",
        "rank",
        "Voucher A17",
        "Voucher B42",
        "--rank",
        "genus",
        "--model",
        "custom/model",
      ],
      {
        reply: {
          model: "fixture-model",
          answers: {
            comparison: {
              type: "choice",
              choice: "equalSingle",
              confidence: 1,
              probabilities: { ...rankProbabilities, equalSingle: 1 },
            },
          },
        },
      },
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["judgment\trank\tside", "SameTaxonAtRank\tgenus\t"]);
    expect(result.requests[0]?.questions.comparison).toMatchObject({
      instructions: expect.stringContaining("at genus rank.\n"),
    });
  }),
);

it.effect("compares a directed set relation using the native operation", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      [
        "set",
        "relation",
        "--relation",
        "subset",
        "--left-target",
        "Quercus",
        "--right-target",
        "Fagaceae",
        "--model",
        "custom/model",
      ],
      {
        reply: {
          model: "fixture-model",
          answers: {
            relation: {
              type: "choice",
              choice: "properSubset",
              confidence: 1,
              probabilities: {
                ...relationProbabilities,
                properSubset: 1,
                multipleLeft0: 0,
                multipleRight0: 0,
              },
            },
          },
        },
      },
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([
      "judgment\trelation\tside\tclarification_target",
      "Yes\tsubset\t\t",
    ]);
    expect(result.requests[0]?.state).toEqual({
      nodes: [
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
        { _tag: "Taxon", record: { scientificName: "Fagaceae" } },
      ],
      left: 0,
      right: 1,
    });
  }),
);

it.effect(
  "rejects delimiter-bearing clarification text and preserves it in structured output",
  () =>
    Effect.gen(function* () {
      const args = [
        "set",
        "relation",
        "--relation",
        "subset",
        "--left-target",
        "Quercus\tFagus",
        "--right-target",
        "Fagaceae",
        "--model",
        "custom/model",
      ];
      const reply = {
        model: "fixture-model",
        answers: {
          relation: {
            type: "choice",
            choice: "multipleLeft0",
            confidence: 1,
            probabilities: { ...relationProbabilities, multipleLeft0: 1, multipleRight0: 0 },
          },
        },
      };
      const text = yield* invoke(args, { reply });
      expect(Result.isFailure(text.outcome)).toBe(true);
      expect(text.stdout).toEqual([]);
      expect(JSON.stringify(text.stderr)).toContain("--format json");
      const json = yield* invoke([...args, "--format", "json"], { reply });
      expect(Result.isSuccess(json.outcome)).toBe(true);
      expect(json.stdout).toEqual([
        JSON.stringify({
          _tag: "MultipleTaxaInSet",
          relation: "subset",
          side: "left",
          taxon: { _tag: "Taxon", record: { scientificName: "Quercus\tFagus" } },
        }),
      ]);
    }),
);

it.effect.each([
  { relation: "subset", tag: "Yes" },
  { relation: "proper-subset", tag: "Yes" },
  { relation: "equivalent", tag: "No" },
  { relation: "overlap", tag: "Yes" },
  { relation: "disjoint", tag: "No" },
])("preserves the native question and answer for set relation $relation", ({ relation, tag }) =>
  Effect.gen(function* () {
    const result = yield* invoke(
      [
        "set",
        "rel",
        "--relation",
        relation,
        "--left-target",
        "Quercus",
        "--right-target",
        "Fagaceae",
        "--model",
        "custom/model",
        "--format",
        "json",
      ],
      {
        reply: {
          model: "fixture-model",
          answers: {
            relation: {
              type: "choice",
              choice: "properSubset",
              confidence: 1,
              probabilities: {
                ...relationProbabilities,
                properSubset: 1,
                multipleLeft0: 0,
                multipleRight0: 0,
              },
            },
          },
        },
      },
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([JSON.stringify({ _tag: tag, relation })]);
    expect(result.requests).toHaveLength(1);
  }),
);

it.effect.each([
  { relation: "subset", tag: "Yes" },
  { relation: "proper-subset", tag: "No" },
  { relation: "equivalent", tag: "Yes" },
  { relation: "overlap", tag: "No" },
  { relation: "disjoint", tag: "Yes" },
])("retains native literal-empty behavior for set relation $relation", ({ relation, tag }) =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "set",
      "relation",
      "--relation",
      relation,
      "--model",
      "custom/model",
      "--no-header",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([`${tag}\t${relation}\t\t`]);
    expect(result.requests).toEqual([]);
  }),
);

it.effect("keeps ID-only clarification targets and metadata intact in JSON", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/target.json`;
    const record = {
      taxonId: { taxonomy: "ncbi", id: "123", release: "2026", curator: "caller" },
      metadata: { sample: ["A17", null] },
    };
    yield* fs.writeFileString(path, JSON.stringify([record]));
    const args = [
      "set",
      "relation",
      "--relation",
      "overlap",
      "--left-target",
      "Quercus",
      "--right-targets-file",
      path,
      "--model",
      "custom/model",
    ];
    const reply = {
      model: "fixture-model",
      answers: {
        relation: {
          type: "choice",
          choice: "multipleRight0",
          confidence: 1,
          probabilities: { ...relationProbabilities, multipleLeft0: 0, multipleRight0: 1 },
        },
      },
    };
    const text = yield* invoke(args, { reply });
    expect(Result.isFailure(text.outcome)).toBe(true);
    expect(text.stdout).toEqual([]);
    expect(JSON.stringify(text.stderr)).toContain("--format json");
    const json = yield* invoke([...args, "--format", "json"], { reply });
    expect(Result.isSuccess(json.outcome)).toBe(true);
    expect(json.stdout).toEqual([
      JSON.stringify({
        _tag: "MultipleTaxaInSet",
        relation: "overlap",
        side: "right",
        taxon: { _tag: "Taxon", record },
      }),
    ]);
    expect(json.requests[0]?.state).toEqual({
      nodes: [
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
        { _tag: "Taxon", record: { taxonId: { taxonomy: "ncbi", id: "123", release: "2026" } } },
      ],
      left: 0,
      right: 1,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    choice: "properSuperset",
    probabilities: { properSuperset: 1 },
    native: { _tag: "PartlyContained" },
  },
  { choice: "disjoint", probabilities: { disjoint: 1 }, native: { _tag: "Disjoint" } },
  {
    choice: "disjoint",
    probabilities: { disjoint: 0.5, properSuperset: 0.5 },
    native: { _tag: "NotContained" },
  },
  { choice: "undetermined", probabilities: { undetermined: 1 }, native: { _tag: "Undetermined" } },
  {
    choice: "multipleBoth",
    probabilities: { multipleBoth: 1 },
    native: { _tag: "MultipleTaxa", side: "both" },
  },
])(
  "retains native containment judgments, including broader answers: $native",
  ({ choice, probabilities, native }) =>
    Effect.gen(function* () {
      const reply = {
        model: "fixture-model",
        answers: {
          containment: {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: {
              ...relationProbabilities,
              multipleLeft: 0,
              multipleRight: 0,
              multipleBoth: 0,
              ...probabilities,
            },
          },
        },
      };
      const args = ["cmp", "within", "Quercus", "Fagaceae", "--model", "custom/model"];
      const result = yield* invoke([...args, "--format", "json"], { reply });
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([JSON.stringify(native)]);
      const text = yield* invoke([...args, "--no-header"], { reply });
      expect(Result.isSuccess(text.outcome)).toBe(true);
      expect(text.stdout).toEqual([`${native._tag}\t${native.side ?? ""}`]);
    }),
);

it.effect.each([
  {
    choice: "equalMultiple",
    probabilities: { equalMultiple: 1 },
    native: { _tag: "SameMultipleTaxaAtRank", rank: "species" },
  },
  {
    choice: "equalSingle",
    probabilities: { equalSingle: 0.5, equalMultiple: 0.5 },
    native: { _tag: "SameTaxaAtRank", rank: "species" },
  },
  {
    choice: "properSubset",
    probabilities: { properSubset: 1 },
    native: { _tag: "LeftTaxaWithinRightAtRank", rank: "species" },
  },
  {
    choice: "properSuperset",
    probabilities: { properSuperset: 1 },
    native: { _tag: "RightTaxaWithinLeftAtRank", rank: "species" },
  },
  {
    choice: "partialOverlap",
    probabilities: { partialOverlap: 1 },
    native: { _tag: "PartlySharedTaxaAtRank", rank: "species" },
  },
  {
    choice: "disjoint",
    probabilities: { disjoint: 1 },
    native: { _tag: "NoSharedTaxaAtRank", rank: "species" },
  },
  {
    choice: "disjoint",
    probabilities: { disjoint: 0.5, partialOverlap: 0.5 },
    native: { _tag: "DifferentTaxaAtRank", rank: "species" },
  },
  {
    choice: "undetermined",
    probabilities: { undetermined: 1 },
    native: { _tag: "Undetermined", rank: "species" },
  },
  {
    choice: "multipleRight",
    probabilities: { multipleRight: 1 },
    native: { _tag: "MultipleTaxaAtRank", rank: "species", side: "right" },
  },
])("retains native rank judgments and rank context: $native", ({ choice, probabilities, native }) =>
  Effect.gen(function* () {
    const reply = {
      model: "fixture-model",
      answers: {
        comparison: {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: { ...rankProbabilities, ...probabilities },
        },
      },
    };
    const args = [
      "compare",
      "rank",
      "Voucher A17",
      "Voucher B42",
      "--rank",
      "species",
      "--model",
      "custom/model",
    ];
    const result = yield* invoke([...args, "--format", "json"], { reply });
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([JSON.stringify(native)]);
    const text = yield* invoke([...args, "--no-header"], { reply });
    expect(Result.isSuccess(text.outcome)).toBe(true);
    expect(text.stdout).toEqual([`${native._tag}\tspecies\t${native.side ?? ""}`]);
  }),
);

it.effect("treats invalid provider responses as failures, not unresolved judgments", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      ["compare", "identity", "Quercus", "Fagus", "--model", "custom/model"],
      {
        reply: {
          model: "fixture-model",
          answers: {
            identity: { type: "choice", choice: "same", confidence: 1, probabilities: {} },
          },
        },
      },
    );
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([]);
    expect(JSON.stringify(result.stderr)).toContain("decision model request failed");
  }),
);

it.effect.each([
  { choice: "undetermined", row: "Undetermined\tsubset\t\t" },
  { choice: "multipleLeft0", row: "MultipleTaxaInSet\tsubset\tleft\tQuercus" },
])("retains unresolved set relations and named clarification targets: $choice", ({ choice, row }) =>
  Effect.gen(function* () {
    const result = yield* invoke(
      [
        "set",
        "relation",
        "--relation",
        "subset",
        "--left-target",
        "Quercus",
        "--right-target",
        "Fagaceae",
        "--model",
        "custom/model",
      ],
      {
        reply: {
          model: "fixture-model",
          answers: {
            relation: {
              type: "choice",
              choice,
              confidence: 1,
              probabilities: {
                ...relationProbabilities,
                multipleLeft0: 0,
                multipleRight0: 0,
                [choice]: 1,
              },
            },
          },
        },
      },
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["judgment\trelation\tside\tclarification_target", row]);
  }),
);
