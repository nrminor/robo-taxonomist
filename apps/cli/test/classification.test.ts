import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Match,
  Result,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestConsole } from "effect/testing";
import { cli } from "../src/cli.ts";

const fixtureReply = {
  model: "fixture-model",
  answers: {
    r0t0: {
      type: "choice",
      choice: "withinTaxon",
      confidence: 1,
      probabilities: { sameTaxon: 0, withinTaxon: 1, noMatch: 0, undetermined: 0 },
    },
  },
};
const wireRequest = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    state: Schema.Json,
    questions: Schema.Record(Schema.String, Schema.Json),
  }),
);

const invoke = (args: readonly string[], replies: readonly object[] = [fixtureReply], stdin = "") =>
  Effect.gen(function* () {
    let requests = 0;
    const payloads: (typeof wireRequest.Type)[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const text = Match.value(request.body).pipe(
          Match.tagsExhaustive({
            Uint8Array: ({ body }) => new TextDecoder().decode(body),
            Empty: () => "",
            Raw: () => "",
            FormData: () => "",
            Stream: () => "",
          }),
        );
        payloads.push(Schema.decodeUnknownSync(wireRequest)(text));
        const reply = replies[requests] ?? fixtureReply;
        requests++;
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } }),
        );
      }),
    );
    const outcome = yield* Command.runWith(cli, { version: "test" })(args).pipe(
      Effect.result,
      Effect.provideService(HttpClient.HttpClient, http),
    );
    return {
      outcome,
      requests,
      payloads,
      stdout: yield* TestConsole.logLines,
      stderr: yield* TestConsole.errorLines,
    };
  }).pipe(
    Effect.provide([
      NodeServices.layer,
      Stdio.layerTest({ stdin: Stream.succeed(new TextEncoder().encode(stdin)) }),
      Layer.fresh(TestConsole.layer),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" })),
    ]),
  );

it.effect(
  "classifies a supplied label and emits its native match support and ranking position",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke([
        "classify",
        "--record",
        "Voucher A17",
        "--target",
        "Quercus",
        "--model",
        "custom/model",
      ]);
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([
        "record\ttarget\tjudgment\tsupport\tranking_position",
        "Voucher A17\tQuercus\tMatched\t1\t1",
      ]);
      expect(result.requests).toBe(1);
      expect(result.stderr).toEqual([]);
    }),
);

it.effect(
  "emits one complete native-shaped classification group with absent usage counts left absent",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke([
        "classify",
        "--record",
        "Voucher A17",
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
      ]);
      expect(Result.isSuccess(result.outcome)).toBe(true);
      const taxon = { _tag: "Taxon", record: { scientificName: "Quercus" } };
      const match = {
        record: "Voucher A17",
        taxon,
        support: 1,
        judgment: { _tag: "Matched" },
        answer: {
          label: "withinTaxon",
          probabilities: { sameTaxon: 0, withinTaxon: 1, noMatch: 0, undetermined: 0 },
          confidence: 1,
        },
      };
      expect(result.stdout.map((line) => JSON.parse(String(line)))).toEqual([
        {
          panel: taxon,
          records: [{ record: "Voucher A17", taxa: [match], ranking: [match] }],
          usage: [{}],
        },
      ]);
    }),
);

it.effect(
  "bounds native classification requests using the existing execution flags and one invocation header policy",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke([
        "classify",
        "--record",
        "A17",
        "--record",
        "B42",
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--batch-size",
        "1",
        "--concurrency",
        "1",
        "--no-header",
      ]);
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual(["A17\tQuercus\tMatched\t1\t1", "B42\tQuercus\tMatched\t1\t1"]);
      expect(result.requests).toBe(2);
    }),
);

it.effect("emits one complete empty result with the supplied panel when there are no records", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "classify",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--format",
      "jsonl",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout.map((line) => JSON.parse(String(line)))).toEqual([
      {
        panel: { _tag: "Taxon", record: { scientificName: "Quercus" } },
        records: [],
        usage: [],
      },
    ]);
    expect(result.requests).toBe(0);
  }),
);

it.effect("rejects delimiter-bearing TSV rather than corrupting columns and points to JSONL", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "classify",
      "--record",
      "Voucher\tA17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--no-header",
    ]);
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([]);
    expect(JSON.stringify(result.stderr)).toContain("--format jsonl");
  }),
);

it.effect("reports deeply nested classification metadata as a safe output failure", () =>
  Effect.gen(function* () {
    const text =
      '{"label":"A17","metadata":' +
      '{"child":'.repeat(20_000) +
      "null" +
      "}".repeat(20_000) +
      "}\n";
    const result = yield* invoke(
      [
        "classify",
        "-",
        "--records-format",
        "jsonl",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
      ],
      [],
      text,
    );
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([]);
    expect(JSON.stringify(result.stderr)).toContain("Cannot serialize classification result");
  }),
);

it.effect.each([
  {
    choice: "noMatch",
    probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 1, undetermined: 0 },
    judgment: "NotMatched",
  },
  {
    choice: "undetermined",
    probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 0, undetermined: 1 },
    judgment: "Undetermined",
  },
])(
  "retains successful unranked $judgment outcomes and their complete answers",
  ({ choice, probabilities, judgment }) =>
    Effect.gen(function* () {
      const args = [
        "classify",
        "--record",
        "A17",
        "--target",
        "Quercus",
        "--model",
        "custom/model",
      ];
      const reply = {
        model: "fixture-model",
        answers: { r0t0: { type: "choice", choice, confidence: 0.75, probabilities } },
        usage: { input_tokens: 7, output_tokens: 3 },
      };
      const text = yield* invoke([...args, "--no-header"], [reply]);
      expect(Result.isSuccess(text.outcome)).toBe(true);
      expect(text.stdout).toEqual([`A17\tQuercus\t${judgment}\t0\t`]);
      const json = yield* invoke([...args, "--format", "jsonl"], [reply]);
      expect(Result.isSuccess(json.outcome)).toBe(true);
      expect(json.stdout.map((line) => JSON.parse(String(line)))).toEqual([
        {
          panel: { _tag: "Taxon", record: { scientificName: "Quercus" } },
          records: [
            {
              record: "A17",
              taxa: [
                {
                  record: "A17",
                  taxon: { _tag: "Taxon", record: { scientificName: "Quercus" } },
                  support: 0,
                  judgment: { _tag: judgment },
                  answer: { label: choice, probabilities, confidence: 0.75 },
                },
              ],
              ranking: [],
            },
          ],
          usage: [{ inputTokens: 7, outputTokens: 3 }],
        },
      ]);
    }),
);

it.effect(
  "preserves repeated target occurrences, stable ties and unranked outcomes without renormalizing support",
  () =>
    Effect.gen(function* () {
      const positive = {
        type: "choice",
        choice: "withinTaxon",
        confidence: 1,
        probabilities: { sameTaxon: 0.25, withinTaxon: 0.5, noMatch: 0.125, undetermined: 0.125 },
      };
      const negative = {
        type: "choice",
        choice: "noMatch",
        confidence: 1,
        probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 1, undetermined: 0 },
      };
      const args = [
        "classify",
        "--record",
        "A17",
        "--record",
        "A17",
        "--target",
        "Quercus",
        "--target",
        "Quercus",
        "--target",
        "Fagus",
        "--model",
        "custom/model",
      ];
      const reply = {
        model: "fixture-model",
        answers: {
          r0t0: positive,
          r0t1: positive,
          r0t2: negative,
          r1t0: positive,
          r1t1: positive,
          r1t2: negative,
        },
      };
      const text = yield* invoke(args, [reply]);
      expect(Result.isSuccess(text.outcome)).toBe(true);
      expect(text.stdout).toEqual([
        "record\ttarget\tjudgment\tsupport\tranking_position",
        "A17\tQuercus\tMatched\t0.75\t1",
        "A17\tQuercus\tMatched\t0.75\t2",
        "A17\tFagus\tNotMatched\t0\t",
        "A17\tQuercus\tMatched\t0.75\t1",
        "A17\tQuercus\tMatched\t0.75\t2",
        "A17\tFagus\tNotMatched\t0\t",
      ]);
      const json = yield* invoke([...args, "--format", "jsonl"], [reply]);
      expect(Result.isSuccess(json.outcome)).toBe(true);
      const result = JSON.parse(String(json.stdout[0]));
      expect(result.panel).toEqual({
        _tag: "Union",
        operands: [
          { _tag: "Taxon", record: { scientificName: "Quercus" } },
          { _tag: "Taxon", record: { scientificName: "Quercus" } },
          { _tag: "Taxon", record: { scientificName: "Fagus" } },
        ],
      });
      expect(result.records).toHaveLength(2);
      expect(result.records[0].taxa.map((match: { support: number }) => match.support)).toEqual([
        0.75, 0.75, 0,
      ]);
      expect(result.records[0].ranking).toEqual(result.records[0].taxa.slice(0, 2));
      expect(result.records[1]).toEqual(result.records[0]);
    }),
);

it.effect("keeps record and target identifier metadata and symbolic panel topology intact", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/panel.json`;
    const record = {
      taxonId: { taxonomy: "ncbi", id: "123", release: "2026", source: "caller" },
      abundance: 0.37,
      metadata: [null, true, "A17"],
    };
    const target = {
      taxonId: { taxonomy: "gbif", id: "456", revision: ["caller"] },
      metadata: { label: "panel entry" },
    };
    const panel = {
      _tag: "Difference",
      left: { _tag: "Taxon", record: target },
      right: { _tag: "Taxon", record: { scientificName: "Fagus", excluded: true } },
    };
    yield* fs.writeFileString(path, JSON.stringify(panel));
    const result = yield* invoke(
      [
        "classify",
        "-",
        "--records-format",
        "jsonl",
        "--targets-file",
        path,
        "--format",
        "jsonl",
        "--model",
        "custom/model",
      ],
      [fixtureReply],
      JSON.stringify(record) + "\n",
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    const decoded = JSON.parse(String(result.stdout[0]));
    expect(decoded.panel).toEqual(panel);
    expect(decoded.records[0].record).toEqual(record);
    expect(decoded.records[0].taxa[0].record).toEqual(record);
    expect(decoded.records[0].taxa[0].taxon.record).toEqual(target);
    expect(decoded.records[0].ranking).toEqual(decoded.records[0].taxa);
    expect(JSON.stringify(result.payloads[0]?.state)).not.toContain("abundance");
    expect(JSON.stringify(result.payloads[0]?.state)).not.toContain("metadata");
    expect(JSON.stringify(result.payloads[0]?.state)).not.toContain("revision");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([1, 2])(
  "emits complete bounded groups with native request usage at concurrency %s",
  (concurrency) =>
    Effect.gen(function* () {
      const result = yield* invoke([
        "classify",
        ...["A17", "B42", "C88"].flatMap((record) => ["--record", record]),
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
        "--batch-size",
        "1",
        "--concurrency",
        String(concurrency),
      ]);
      expect(Result.isSuccess(result.outcome)).toBe(true);
      const groups = result.stdout.map((line) => JSON.parse(String(line)));
      expect(groups.map((group) => group.records.length)).toEqual(
        concurrency === 1 ? [1, 1, 1] : [2, 1],
      );
      expect(
        groups.flatMap((group) => group.records.map((row: { record: string }) => row.record)),
      ).toEqual(["A17", "B42", "C88"]);
      expect(groups.map((group) => group.usage.length)).toEqual(
        concurrency === 1 ? [1, 1, 1] : [2, 1],
      );
      expect(groups.every((group) => group.panel.record.scientificName === "Quercus")).toBe(true);
      expect(result.requests).toBe(3);
    }),
);

it.effect("retains all records with empty outcomes when the panel offers no taxa", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "classify",
      "--record",
      "A17",
      "--record",
      "A17",
      "--model",
      "custom/model",
      "--format",
      "jsonl",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout.map((line) => JSON.parse(String(line)))).toEqual([
      {
        panel: { _tag: "Empty" },
        records: [
          { record: "A17", taxa: [], ranking: [] },
          { record: "A17", taxa: [], ranking: [] },
        ],
        usage: [],
      },
    ]);
    expect(result.requests).toBe(0);
  }),
);

it.effect("does not require a text label when an empty panel has no TSV rows to emit", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      ["classify", "-", "--records-format", "jsonl", "--model", "custom/model", "--no-header"],
      [],
      '{"taxonId":{"taxonomy":"ncbi","id":"123"}}\n',
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([]);
    expect(result.requests).toBe(0);
  }),
);

it.effect("does not emit a result for a failed group after a completed JSONL prefix", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      [
        "classify",
        "--record",
        "A17",
        "--record",
        "B42",
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
        "--batch-size",
        "1",
      ],
      [fixtureReply, { model: "fixture-model", answers: {} }],
    );
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(String(result.stdout[0])).records[0].record).toBe("A17");
    expect(JSON.stringify(result.stderr)).toContain("decision model request failed");
    expect(result.requests).toBe(2);
  }),
);

it.effect("preserves only the completed prefix when a later record source fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const missing = `${directory}/missing.txt`;
    const result = yield* invoke([
      "classify",
      missing,
      "--record",
      "A17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--format",
      "jsonl",
      "--batch-size",
      "1",
    ]);
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(String(result.stdout[0])).records[0].record).toBe("A17");
    expect(JSON.stringify(result.stderr)).toContain(missing);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
