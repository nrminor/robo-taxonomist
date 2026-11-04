import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Result,
  Schema,
  Sink,
  Stdio,
} from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestConsole } from "effect/testing";
import { TaxonName } from "robo-taxonomist";
import { cli } from "../src/cli.ts";
import * as Documents from "../src/documents.ts";

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

const invoke = Effect.fn("ComparisonTest.invoke")(function* (
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly reply?: unknown;
    readonly status?: number;
  } = {},
) {
  const requests: Array<typeof wireRequest.Type> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const text = Match.value(request.body).pipe(
        Match.tag("Uint8Array", ({ body }) => new TextDecoder().decode(body)),
        Match.orElse(() => {
          throw new Error("Expected a JSON provider request");
        }),
      );
      const body = yield* Schema.decodeEffect(wireRequest)(text).pipe(Effect.orDie);
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
  let output = "";
  const decoder = new TextDecoder();
  const stdio = Stdio.layerTest({
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          output += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        }),
      ),
  });
  const { outcome, stderr } = yield* Effect.gen(function* () {
    const outcome = yield* Command.runWith(cli, { version: "test" })(args).pipe(Effect.result);
    const stderr = yield* TestConsole.errorLines;
    return { outcome, stderr };
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide([
      NodeServices.layer,
      stdio,
      ConfigProvider.layer(
        ConfigProvider.fromUnknown(options.env ?? { TYPESAFE_API_KEY: "fixture-key" }),
      ),
      Layer.fresh(TestConsole.layer),
    ]),
  );
  output += decoder.decode();
  return {
    outcome,
    output,
    stdout: output === "" ? [] : output.replace(/\n$/, "").split("\n"),
    stderr,
    requests,
  };
});

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
    const request = Array.head(result.requests).pipe(Option.getOrThrow);
    expect(request.model).toBe("custom/model");
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
      expect(JSON.stringify(result.stderr)).toMatch(/model|provider/);
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
  {
    choice: "different",
    row: "DifferentTaxa\t",
    native: Documents.IdentityJudgment.cases.DifferentTaxa.make({}),
  },
  {
    choice: "undetermined",
    row: "Undetermined\t",
    native: Documents.IdentityJudgment.cases.Undetermined.make({}),
  },
  {
    choice: "multipleLeft",
    row: "MultipleTaxa\tleft",
    native: Documents.IdentityJudgment.cases.MultipleTaxa.make({ side: "left" }),
  },
  {
    choice: "multipleRight",
    row: "MultipleTaxa\tright",
    native: Documents.IdentityJudgment.cases.MultipleTaxa.make({ side: "right" }),
  },
  {
    choice: "multipleBoth",
    row: "MultipleTaxa\tboth",
    native: Documents.IdentityJudgment.cases.MultipleTaxa.make({ side: "both" }),
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
      const request = Array.head(result.requests).pipe(Option.getOrThrow);
      expect(request.model).toBe(expected);
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
    expect(result.requests).toHaveLength(1);
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
    expect(result.requests).toHaveLength(1);
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
    const request = Array.head(result.requests).pipe(Option.getOrThrow);
    expect(request.state).toEqual({
      nodes: [
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
        { _tag: "Taxon", record: { scientificName: "Fagaceae" } },
      ],
      left: 0,
      right: 1,
    });
  }),
);

it.effect("quotes delimiter-bearing clarification text and preserves it in structured output", () =>
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
    expect(Result.isSuccess(text.outcome)).toBe(true);
    expect(text.output).toBe(
      'judgment\trelation\tside\tclarification_target\nMultipleTaxaInSet\tsubset\tleft\t"Quercus\tFagus"\n',
    );
    const json = yield* invoke([...args, "--format", "json"], { reply });
    expect(Result.isSuccess(json.outcome)).toBe(true);
    const expectedTaxon = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus\tFagus") }),
    });
    const expectedJudgment = Documents.SetRelationJudgment.cases.MultipleTaxaInSet.make({
      relation: "subset",
      side: "left",
      taxon: expectedTaxon,
    });
    expect(json.stdout).toEqual([JSON.stringify(expectedJudgment)]);
  }),
);

it.effect.each([
  {
    relation: "subset",
    native: Documents.SetRelationJudgment.cases.Yes.make({ relation: "subset" }),
  },
  {
    relation: "proper-subset",
    native: Documents.SetRelationJudgment.cases.Yes.make({ relation: "proper-subset" }),
  },
  {
    relation: "equivalent",
    native: Documents.SetRelationJudgment.cases.No.make({ relation: "equivalent" }),
  },
  {
    relation: "overlap",
    native: Documents.SetRelationJudgment.cases.Yes.make({ relation: "overlap" }),
  },
  {
    relation: "disjoint",
    native: Documents.SetRelationJudgment.cases.No.make({ relation: "disjoint" }),
  },
])("preserves the native question and answer for set relation $relation", ({ relation, native }) =>
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
    expect(result.stdout).toEqual([JSON.stringify(native)]);
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

it.effect("encodes ID-only clarification targets without extra metadata in JSON", () =>
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
    const expectedTaxon = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({
        taxonId: { taxonomy: "ncbi", id: "123", release: "2026" },
      }),
    });
    const expectedJudgment = Documents.SetRelationJudgment.cases.MultipleTaxaInSet.make({
      relation: "overlap",
      side: "right",
      taxon: expectedTaxon,
    });
    expect(json.stdout).toEqual([JSON.stringify(expectedJudgment)]);
    const request = Array.head(json.requests).pipe(Option.getOrThrow);
    expect(request.state).toEqual({
      nodes: [
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
        { _tag: "Taxon", record: { taxonId: { taxonomy: "ncbi", id: "123", release: "2026" } } },
      ],
      left: 0,
      right: 1,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    choice: "properSuperset",
    probabilities: { properSuperset: 1 },
    native: Documents.ContainmentJudgment.cases.PartlyContained.make({}),
  },
  {
    choice: "disjoint",
    probabilities: { disjoint: 1 },
    native: Documents.ContainmentJudgment.cases.Disjoint.make({}),
  },
  {
    choice: "disjoint",
    probabilities: { disjoint: 0.5, properSuperset: 0.5 },
    native: Documents.ContainmentJudgment.cases.NotContained.make({}),
  },
  {
    choice: "undetermined",
    probabilities: { undetermined: 1 },
    native: Documents.ContainmentJudgment.cases.Undetermined.make({}),
  },
  {
    choice: "multipleBoth",
    probabilities: { multipleBoth: 1 },
    native: Documents.ContainmentJudgment.cases.MultipleTaxa.make({ side: "both" }),
  },
  {
    choice: "multipleLeft",
    probabilities: { multipleLeft: 1 },
    native: Documents.ContainmentJudgment.cases.MultipleTaxa.make({ side: "left" }),
  },
  {
    choice: "multipleRight",
    probabilities: { multipleRight: 1 },
    native: Documents.ContainmentJudgment.cases.MultipleTaxa.make({ side: "right" }),
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
      const expectedSide = "side" in native ? native.side : "";
      expect(text.stdout).toEqual([`${native._tag}\t${expectedSide}`]);
    }),
);

it.effect.each([
  {
    choice: "equalMultiple",
    probabilities: { equalMultiple: 1 },
    native: Documents.RankJudgment.cases.SameMultipleTaxaAtRank.make({ rank: "species" }),
  },
  {
    choice: "equalSingle",
    probabilities: { equalSingle: 0.5, equalMultiple: 0.5 },
    native: Documents.RankJudgment.cases.SameTaxaAtRank.make({ rank: "species" }),
  },
  {
    choice: "properSubset",
    probabilities: { properSubset: 1 },
    native: Documents.RankJudgment.cases.LeftTaxaWithinRightAtRank.make({ rank: "species" }),
  },
  {
    choice: "properSuperset",
    probabilities: { properSuperset: 1 },
    native: Documents.RankJudgment.cases.RightTaxaWithinLeftAtRank.make({ rank: "species" }),
  },
  {
    choice: "partialOverlap",
    probabilities: { partialOverlap: 1 },
    native: Documents.RankJudgment.cases.PartlySharedTaxaAtRank.make({ rank: "species" }),
  },
  {
    choice: "disjoint",
    probabilities: { disjoint: 1 },
    native: Documents.RankJudgment.cases.NoSharedTaxaAtRank.make({ rank: "species" }),
  },
  {
    choice: "disjoint",
    probabilities: { disjoint: 0.5, partialOverlap: 0.5 },
    native: Documents.RankJudgment.cases.DifferentTaxaAtRank.make({ rank: "species" }),
  },
  {
    choice: "undetermined",
    probabilities: { undetermined: 1 },
    native: Documents.RankJudgment.cases.Undetermined.make({ rank: "species" }),
  },
  {
    choice: "multipleRight",
    probabilities: { multipleRight: 1 },
    native: Documents.RankJudgment.cases.MultipleTaxaAtRank.make({
      rank: "species",
      side: "right",
    }),
  },
  {
    choice: "multipleLeft",
    probabilities: { multipleLeft: 1 },
    native: Documents.RankJudgment.cases.MultipleTaxaAtRank.make({
      rank: "species",
      side: "left",
    }),
  },
  {
    choice: "multipleBoth",
    probabilities: { multipleBoth: 1 },
    native: Documents.RankJudgment.cases.MultipleTaxaAtRank.make({
      rank: "species",
      side: "both",
    }),
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
    const expectedSide = "side" in native ? native.side : "";
    expect(text.stdout).toEqual([`${native._tag}\tspecies\t${expectedSide}`]);
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
    expect(JSON.stringify(result.stderr)).toContain("unusable answer");
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
