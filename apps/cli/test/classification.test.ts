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
  Stream,
} from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestConsole } from "effect/testing";
import { TaxonName } from "robo-taxonomist";
import { cli } from "../src/cli.ts";
import * as Documents from "../src/documents.ts";
import * as TestJson from "./Json.ts";

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
  Effect.suspend(() => {
    let output = "";
    const decoder = new TextDecoder();
    return Effect.gen(function* () {
      let requests = 0;
      const payloads: (typeof wireRequest.Type)[] = [];
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const text = Match.value(request.body).pipe(
            Match.tag("Uint8Array", ({ body }) => new TextDecoder().decode(body)),
            Match.orElse(() => {
              throw new Error("Expected a JSON provider request");
            }),
          );
          const payload = yield* Schema.decodeEffect(wireRequest)(text);
          payloads.push(payload);
          const reply = Array.get(replies, requests).pipe(Option.getOrElse(() => fixtureReply));
          requests++;
          const body = yield* TestJson.encode(reply);
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              headers: { "content-type": "application/json" },
            }),
          );
        }).pipe(Effect.orDie),
      );
      const outcome = yield* Command.runWith(cli, { version: "test" })(args).pipe(
        Effect.result,
        Effect.provideService(HttpClient.HttpClient, http),
      );
      output += decoder.decode();
      return {
        outcome,
        requests,
        payloads,
        output,
        stdout: output === "" ? [] : output.replace(/\n$/, "").split("\n"),
        stderr: yield* TestConsole.errorLines,
      };
    }).pipe(
      Effect.provide([
        NodeServices.layer,
        Stdio.layerTest({
          stdin: Stream.succeed(new TextEncoder().encode(stdin)),
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Effect.sync(() => {
                output +=
                  typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
              }),
            ),
        }),
        Layer.fresh(TestConsole.layer),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" })),
      ]),
    );
  });

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
        "Voucher A17\tQuercus\tWithinTaxon\t1\t1",
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
        judgment: { _tag: "WithinTaxon", support: 1 },
        answer: {
          label: "withinTaxon",
          probabilities: { sameTaxon: 0, withinTaxon: 1, noMatch: 0, undetermined: 0 },
          confidence: 1,
        },
      };
      const wire = yield* Effect.forEach(result.stdout, (line) =>
        Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line),
      );
      expect(wire).toEqual([
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
      expect(result.stdout).toEqual([
        "A17\tQuercus\tWithinTaxon\t1\t1",
        "B42\tQuercus\tWithinTaxon\t1\t1",
      ]);
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
    const wire = yield* Effect.forEach(result.stdout, (line) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line),
    );
    const expectedPanel = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus") }),
    });
    expect(wire).toEqual([
      {
        panel: expectedPanel,
        records: [],
        usage: [],
      },
    ]);
    expect(result.requests).toBe(0);
  }),
);

it.effect.each([
  { flags: [], output: "record\ttarget\tjudgment\tsupport\tranking_position\n" },
  { flags: ["--no-header"], output: "" },
])("honors the TSV header policy for an empty classification: $flags", ({ flags, output }) =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "classify",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      ...flags,
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.output).toBe(output);
    expect(result.requests).toBe(0);
  }),
);

it.effect("quotes delimiter-bearing classification TSV", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "classify",
      "--record",
      'Voucher\tA17\n"sample"',
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--no-header",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.output).toBe('"Voucher\tA17\n""sample"""\tQuercus\tWithinTaxon\t1\t1\n');
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
    const stderr = yield* TestJson.encode(result.stderr);
    expect(stderr).toContain("Cannot serialize output");
  }),
);

it.effect.each([
  {
    choice: "noMatch",
    probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 1, undetermined: 0 },
    judgment: "NotMatched",
    support: 1,
  },
  {
    choice: "undetermined",
    probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 0, undetermined: 1 },
    judgment: "Undetermined",
    support: undefined,
  },
  {
    choice: "sameTaxon",
    probabilities: { sameTaxon: 0.49, withinTaxon: 0.49, noMatch: 0.01, undetermined: 0.01 },
    judgment: "Undetermined",
    support: undefined,
  },
])(
  "retains successful unranked $judgment outcomes and their complete answers",
  ({ choice, probabilities, judgment, support }) =>
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
      expect(text.stdout).toEqual([`A17\tQuercus\t${judgment}\t${support ?? ""}\t`]);
      const json = yield* invoke([...args, "--format", "jsonl"], [reply]);
      expect(Result.isSuccess(json.outcome)).toBe(true);
      const wire = yield* Effect.forEach(json.stdout, (line) =>
        Schema.decodeEffect(Schema.fromJsonString(Documents.Classification))(line),
      );
      const expectedTaxon = Documents.SetDocument.cases.Taxon.make({
        record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus") }),
      });
      expect(wire).toEqual([
        {
          panel: expectedTaxon,
          records: [
            {
              record: "A17",
              taxa: [
                {
                  record: "A17",
                  taxon: expectedTaxon,
                  judgment:
                    support === undefined ? { _tag: judgment } : { _tag: judgment, support },
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
        "A17\tQuercus\tWithinTaxon\t0.5\t1",
        "A17\tQuercus\tWithinTaxon\t0.5\t2",
        "A17\tFagus\tNotMatched\t1\t",
        "A17\tQuercus\tWithinTaxon\t0.5\t1",
        "A17\tQuercus\tWithinTaxon\t0.5\t2",
        "A17\tFagus\tNotMatched\t1\t",
      ]);
      const json = yield* invoke([...args, "--format", "jsonl"], [reply]);
      expect(Result.isSuccess(json.outcome)).toBe(true);
      const line = Array.head(json.stdout).pipe(Option.getOrThrow);
      const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line);
      const result = yield* Schema.decodeUnknownEffect(Documents.Classification)(wire);
      expect(result).toEqual(wire);
      const expectedOak = Documents.SetDocument.cases.Taxon.make({
        record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus") }),
      });
      const expectedBeech = Documents.SetDocument.cases.Taxon.make({
        record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Fagus") }),
      });
      const expectedPanel = Documents.SetDocument.cases.Union.make({
        operands: [expectedOak, expectedOak, expectedBeech],
      });
      expect(result.panel).toEqual(expectedPanel);
      expect(result.records).toHaveLength(2);
      const first = Array.get(result.records, 0).pipe(Option.getOrThrow);
      const second = Array.get(result.records, 1).pipe(Option.getOrThrow);
      expect(first.taxa.map((match) => match.judgment)).toEqual([
        { _tag: "WithinTaxon", support: 0.5 },
        { _tag: "WithinTaxon", support: 0.5 },
        { _tag: "NotMatched", support: 1 },
      ]);
      expect(first.ranking).toEqual(first.taxa.slice(0, 2));
      expect(second).toEqual(first);
    }),
);

it.effect("keeps record and target identifier metadata and symbolic panel topology intact", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/panel.json`;
    const record = Documents.RecordDocument.make({
      taxonId: { taxonomy: "ncbi", id: "123", release: "2026", source: "caller" },
      abundance: 0.37,
      metadata: [null, true, "A17"],
    });
    const target = Documents.RecordDocument.make({
      taxonId: { taxonomy: "gbif", id: "456", revision: ["caller"] },
      metadata: { label: "panel entry" },
    });
    const included = Documents.SetDocument.cases.Taxon.make({ record: target });
    const excluded = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({
        scientificName: TaxonName.make("Fagus"),
        excluded: true,
      }),
    });
    const panel = Documents.SetDocument.cases.Difference.make({ left: included, right: excluded });
    const panelText = yield* TestJson.encode(panel);
    yield* fs.writeFileString(path, panelText);
    const recordText = yield* TestJson.encode(record);
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
      recordText + "\n",
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    const line = Array.head(result.stdout).pipe(Option.getOrThrow);
    const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line);
    const decoded = yield* Schema.decodeUnknownEffect(Documents.Classification)(wire);
    expect(decoded).toEqual(wire);
    const row = Array.head(decoded.records).pipe(Option.getOrThrow);
    const match = Array.head(row.taxa).pipe(Option.getOrThrow);
    const payload = Array.head(result.payloads).pipe(Option.getOrThrow);
    expect(decoded.panel).toEqual(panel);
    expect(row.record).toEqual(record);
    expect(match.record).toEqual(record);
    expect(match.taxon.record).toEqual(target);
    expect(row.ranking).toEqual(row.taxa);
    const stateText = yield* TestJson.encode(payload.state);
    expect(stateText).not.toContain("abundance");
    expect(stateText).not.toContain("metadata");
    expect(stateText).not.toContain("revision");
  }).pipe(Effect.provide(NodeServices.layer)),
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
      const groups = yield* Effect.forEach(result.stdout, (line) =>
        Schema.decodeEffect(Schema.fromJsonString(Documents.Classification))(line),
      );
      expect(groups.map((group) => group.records.length)).toEqual(
        concurrency === 1 ? [1, 1, 1] : [2, 1],
      );
      expect(groups.flatMap((group) => group.records.map((row) => row.record))).toEqual([
        "A17",
        "B42",
        "C88",
      ]);
      expect(groups.map((group) => group.usage.length)).toEqual(
        concurrency === 1 ? [1, 1, 1] : [2, 1],
      );
      expect(
        groups.every(
          (group) =>
            group.panel._tag === "Taxon" && group.panel.record.scientificName === "Quercus",
        ),
      ).toBe(true);
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
    const wire = yield* Effect.forEach(result.stdout, (line) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line),
    );
    const expectedPanel = Documents.SetDocument.cases.Empty.make({});
    expect(wire).toEqual([
      {
        panel: expectedPanel,
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
    const line = Array.head(result.stdout).pipe(Option.getOrThrow);
    const document = yield* Schema.decodeEffect(Schema.fromJsonString(Documents.Classification))(
      line,
    );
    const row = Array.head(document.records).pipe(Option.getOrThrow);
    expect(row.record).toBe("A17");
    const stderr = yield* TestJson.encode(result.stderr);
    expect(stderr).toContain("unusable answer");
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
    const line = Array.head(result.stdout).pipe(Option.getOrThrow);
    const document = yield* Schema.decodeEffect(Schema.fromJsonString(Documents.Classification))(
      line,
    );
    const row = Array.head(document.records).pipe(Option.getOrThrow);
    expect(row.record).toBe("A17");
    const stderr = yield* TestJson.encode(result.stderr);
    expect(stderr).toContain(missing);
  }).pipe(Effect.provide(NodeServices.layer)),
);
