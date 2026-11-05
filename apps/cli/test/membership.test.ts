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
  Record,
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

const wireRequest = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.Json,
    questions: Schema.Record(Schema.String, Schema.Json),
  }),
);

const invoke = (
  args: readonly string[],
  replies: readonly (readonly string[])[] = [["member"]],
  stdin = "",
) =>
  Effect.suspend(() => {
    let output = "";
    const decoder = new TextDecoder();
    return Effect.gen(function* () {
      const requests: (typeof wireRequest.Type)[] = [];
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const text = Match.value(request.body).pipe(
            Match.tag("Uint8Array", ({ body }) => new TextDecoder().decode(body)),
            Match.orElse(() => {
              throw new Error("Expected a JSON provider request");
            }),
          );
          const payload = yield* Schema.decodeEffect(wireRequest)(text).pipe(Effect.orDie);
          const choices = Array.get(replies, requests.length).pipe(
            Option.getOrElse(() => ["member"]),
          );
          requests.push(payload);
          const answers = Record.fromEntries(
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
          );
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ model: "fixture-model", answers }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      const outcome = yield* Command.runWith(cli, { version: "test" })(args).pipe(
        Effect.result,
        Effect.provideService(HttpClient.HttpClient, http),
      );
      output += decoder.decode();
      return {
        outcome,
        requests,
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
        ConfigProvider.layer(ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" })),
        Layer.fresh(TestConsole.layer),
      ]),
    );
  });

it.effect("quotes delimiter-bearing membership TSV", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      "check",
      'Voucher\tA17\n"sample"',
      "--target",
      "Quercus",
      "--model",
      "custom/model",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.output).toBe(
      'judgment\trecord\tclarification_target\nMember\t"Voucher\tA17\n""sample"""\t\n',
    );
  }),
);

it.effect("partitions a plain record file without requiring an encoding flag", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/detections.txt`;
    yield* fs.writeFileString(path, "Voucher A17\n");
    const result = yield* invoke([
      "mem",
      "part",
      path,
      "--target",
      "Quercus",
      "--model",
      "custom/model",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([
      "judgment\trecord\tclarification_target",
      "Member\tVoucher A17\t",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retains identifying fields and arbitrary metadata from structured record files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/detections.json`;
    const record = {
      taxonId: { taxonomy: "ncbi", id: "123", revision: ["caller"] },
      abundance: 0.37,
      metadata: { sample: "A17", note: null },
    };
    yield* fs.writeFileString(path, JSON.stringify([record]));
    const result = yield* invoke([
      "membership",
      "partition",
      path,
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--format",
      "jsonl",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([
      JSON.stringify({ record, judgment: Documents.MembershipJudgment.cases.Member.make({}) }),
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("asks the native all-records quantifier instead of returning membership rows", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      "all",
      "--record",
      "Voucher A17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["judgment\tquantifier\tclarification_target", "Yes\tall\t"]);
  }),
);

it.effect(
  "asks whether any record belongs without deriving the answer from partition buckets",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke([
        "mem",
        "any",
        "--record",
        "Voucher A17",
        "--target",
        "Quercus",
        "--model",
        "custom/model",
      ]);
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual(["judgment\tquantifier\tclarification_target", "Yes\tany\t"]);
    }),
);

it.effect("returns a successful native No when the none quantifier finds a member", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      "none",
      "--record",
      "Voucher A17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["judgment\tquantifier\tclarification_target", "No\tnone\t"]);
  }),
);

it.effect(
  "bounds partition requests using the native execution flags and suppresses the invocation header",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke([
        "mem",
        "part",
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
      expect(result.stdout).toEqual(["Member\tA17\t", "Member\tB42\t"]);
      const questionIdsByRequest = result.requests.map(({ questions }) => Record.keys(questions));
      expect(questionIdsByRequest).toEqual([["record0"], ["record0"]]);
    }),
);

it.effect("retains a quantifier clarification node in JSON after scanning the complete input", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      [
        "mem",
        "all",
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
        "--format",
        "json",
      ],
      [["undetermined"], ["multipleTarget0"]],
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    const expectedTarget = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus") }),
    });
    const expected = Documents.QuantifierJudgment.cases.MultipleTaxaInTarget.make({
      quantifier: "all",
      target: expectedTarget,
    });
    expect(result.stdout).toEqual([JSON.stringify(expected)]);
    expect(result.requests).toHaveLength(2);
  }),
);

it.effect.each([
  { args: ["check", "A17"], row: "Member\tA17\t" },
  { args: ["all", "--record", "A17"], row: "Yes\tall\t" },
])("honors --no-header for the remaining membership tables: $args", ({ args, row }) =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      ...args,
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--no-header",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([row]);
  }),
);

it.effect("preserves all five native buckets, duplicate records and within-bucket order", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      [
        "mem",
        "part",
        ...["A17", "B42", "mixed", "unknown", "review", "A17"].flatMap((record) => [
          "--record",
          record,
        ]),
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
      ],
      [["member", "notMember", "mixed", "undetermined", "multipleTarget0", "member"]],
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    const wire = yield* Effect.forEach(result.stdout, (line) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line),
    );
    const expectedTarget = Documents.SetDocument.cases.Taxon.make({
      record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus") }),
    });
    const expectedClarification = Documents.MembershipJudgment.cases.MultipleTaxaInTarget.make({
      target: expectedTarget,
    });
    expect(wire).toEqual([
      { record: "A17", judgment: Documents.MembershipJudgment.cases.Member.make({}) },
      { record: "A17", judgment: Documents.MembershipJudgment.cases.Member.make({}) },
      { record: "B42", judgment: Documents.MembershipJudgment.cases.NotMember.make({}) },
      { record: "mixed", judgment: Documents.MembershipJudgment.cases.MixedMembership.make({}) },
      { record: "unknown", judgment: Documents.MembershipJudgment.cases.Undetermined.make({}) },
      { record: "review", judgment: expectedClarification },
    ]);
    expect(result.requests).toHaveLength(1);
  }),
);

it.effect("uses literal-first then positional-file order without inspecting literal paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const first = `${directory}/first.txt`;
    const second = `${directory}/second.jsonl`;
    yield* fs.writeFileString(first, "  A17  \nA17\n");
    yield* fs.writeFileString(second, '{"label":"B42","metadata":{"abundance":2}}\n');
    const result = yield* invoke(
      [
        "mem",
        "part",
        first,
        second,
        "--record",
        first,
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
      ],
      [["member", "member", "member", "member"]],
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    const rows = yield* Effect.forEach(result.stdout, (line) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ record: Schema.Json })))(line),
    );
    expect(rows.map((row) => row.record)).toEqual([
      first,
      "  A17  ",
      "A17",
      { label: "B42", metadata: { abundance: 2 } },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    file: "records.txt",
    contents: '{"label":"A17","extra":[1,null]}\n',
    flags: ["--records-format", "jsonl"],
    record: { label: "A17", extra: [1, null] },
  },
  { file: "records.json", contents: "A17\n", flags: ["--records-format", "text"], record: "A17" },
])(
  "lets the role-specific format override the record filename: $file",
  ({ file, contents, flags, record }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = `${directory}/${file}`;
      yield* fs.writeFileString(path, contents);
      const result = yield* invoke([
        "mem",
        "part",
        path,
        ...flags,
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
      ]);
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([
        JSON.stringify({ record, judgment: Documents.MembershipJudgment.cases.Member.make({}) }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { suffix: "json", contents: "A17" },
  { suffix: "jsonl", contents: '{"metadata":"unidentified"}\n' },
  { suffix: "txt", contents: "\n" },
])(
  "rejects invalid $suffix records without silently falling back to labels",
  ({ suffix, contents }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = `${directory}/records.${suffix}`;
      yield* fs.writeFileString(path, contents);
      const result = yield* invoke([
        "mem",
        "part",
        path,
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--format",
        "jsonl",
      ]);
      expect(Result.isFailure(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([]);
      expect(result.requests).toEqual([]);
      expect(JSON.stringify(result.stderr)).toContain(path);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { command: "all", native: Documents.QuantifierJudgment.cases.Yes.make({ quantifier: "all" }) },
  { command: "any", native: Documents.QuantifierJudgment.cases.No.make({ quantifier: "any" }) },
  { command: "none", native: Documents.QuantifierJudgment.cases.Yes.make({ quantifier: "none" }) },
])("retains native vacuous behavior on empty record inputs: $command", ({ command, native }) =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      command,
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--format",
      "json",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([JSON.stringify(native)]);
    expect(result.requests).toEqual([]);
  }),
);

it.effect.each([
  { flags: [], output: "judgment\trecord\tclarification_target\n" },
  { flags: ["--no-header"], output: "" },
])("honors the TSV header policy for an empty partition: $flags", ({ flags, output }) =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      "part",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      ...flags,
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.output).toBe(output);
    expect(result.requests).toEqual([]);
  }),
);

it.effect.each([
  { flags: ["--format", "jsonl"], format: "jsonl", prefix: "" },
  { flags: [], format: "tsv", prefix: "judgment\trecord\tclarification_target\n" },
  { flags: ["--no-header"], format: "tsv", prefix: "" },
])(
  "fails after an emitted prefix when a later record source cannot be read: $flags",
  ({ flags, format, prefix }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const missing = `${directory}/missing.txt`;
      const result = yield* invoke([
        "mem",
        "part",
        missing,
        "--record",
        "A17",
        "--target",
        "Quercus",
        "--model",
        "custom/model",
        "--batch-size",
        "1",
        ...flags,
      ]);
      expect(Result.isFailure(result.outcome)).toBe(true);
      const expectedRow = {
        record: "A17",
        judgment: Documents.MembershipJudgment.cases.Member.make({}),
      };
      expect(result.output).toBe(
        format === "jsonl" ? `${JSON.stringify(expectedRow)}\n` : `${prefix}Member\tA17\t\n`,
      );
      expect(JSON.stringify(result.stderr)).toContain(missing);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads all quantifier inputs before allowing a decisive early model answer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const missing = `${directory}/missing.txt`;
    const result = yield* invoke([
      "mem",
      "any",
      missing,
      "--record",
      "A17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--batch-size",
      "1",
    ]);
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([]);
    expect(result.requests).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("quotes delimiter-bearing quantifier clarification text", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      ["mem", "all", "--record", "A17", "--target", "Quercus\tFagus", "--model", "custom/model"],
      [["multipleTarget0"]],
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.output).toBe(
      'judgment\tquantifier\tclarification_target\nMultipleTaxaInTarget\tall\t"Quercus\tFagus"\n',
    );
  }),
);

it.effect("retains an undetermined quantifier without clarification text in TSV", () =>
  Effect.gen(function* () {
    const result = yield* invoke(
      ["mem", "all", "--record", "A17", "--target", "Quercus", "--model", "custom/model"],
      [["undetermined"]],
    );
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.output).toBe("judgment\tquantifier\tclarification_target\nUndetermined\tall\t\n");
  }),
);

it.effect.each([
  { text: "A17\n", flags: [], record: "A17" },
  { text: '{"label":"A17","extra":true}\n', flags: [], record: '{"label":"A17","extra":true}' },
  {
    text: '{"label":"A17","extra":true}\n',
    flags: ["--records-format", "jsonl"],
    record: { label: "A17", extra: true },
  },
  {
    text: '[{"scientificName":"Quercus robur","abundance":0.5}]',
    flags: ["--records-format", "json"],
    record: { scientificName: "Quercus robur", abundance: 0.5 },
  },
])(
  "reads record stdin using the explicit encoding or default text: $flags",
  ({ text, flags, record }) =>
    Effect.gen(function* () {
      const result = yield* invoke(
        [
          "mem",
          "part",
          "-",
          ...flags,
          "--target",
          "Quercus",
          "--model",
          "custom/model",
          "--format",
          "jsonl",
        ],
        [["member"]],
        text,
      );
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([
        JSON.stringify({ record, judgment: Documents.MembershipJudgment.cases.Member.make({}) }),
      ]);
    }),
);

it.effect.each([{ files: ["-", "-"] }, { files: ["-", "--targets-file", "-"] }])(
  "rejects multiple stdin consumers across operand roles: $files",
  ({ files }) =>
    Effect.gen(function* () {
      const result = yield* invoke(
        [
          "mem",
          "part",
          ...files,
          "--target",
          "Quercus",
          "--model",
          "custom/model",
          "--format",
          "jsonl",
        ],
        [["member"]],
        "A17\n",
      );
      expect(Result.isFailure(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([]);
      expect(result.requests).toEqual([]);
      expect(JSON.stringify(result.stderr)).toContain("stdin can only be used once");
    }),
);

it.effect(
  "fails without inventing an unresolved result when a later provider response is invalid",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke(
        [
          "mem",
          "part",
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
          "--format",
          "jsonl",
        ],
        [["member"], []],
      );
      expect(Result.isFailure(result.outcome)).toBe(true);
      const expectedRow = {
        record: "A17",
        judgment: Documents.MembershipJudgment.cases.Member.make({}),
      };
      expect(result.stdout).toEqual([JSON.stringify(expectedRow)]);
      expect(JSON.stringify(result.stderr)).toContain("unusable answer");
    }),
);

it.effect("reports JSONL serialization limits as operational errors rather than defects", () =>
  Effect.gen(function* () {
    const text =
      '{"label":"A17","metadata":' +
      '{"child":'.repeat(20_000) +
      "null" +
      "}".repeat(20_000) +
      "}\n";
    const result = yield* invoke(
      [
        "mem",
        "part",
        "-",
        "--records-format",
        "jsonl",
        "--format",
        "jsonl",
        "--model",
        "custom/model",
      ],
      [],
      text,
    );
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([]);
    expect(JSON.stringify(result.stderr)).toContain("Cannot serialize output");
  }),
);

it.effect.each([
  {
    command: "all",
    choices: ["undetermined", "mixed"],
    native: Documents.QuantifierJudgment.cases.No.make({ quantifier: "all" }),
  },
  {
    command: "any",
    choices: ["undetermined", "member"],
    native: Documents.QuantifierJudgment.cases.Yes.make({ quantifier: "any" }),
  },
  {
    command: "none",
    choices: ["undetermined", "member"],
    native: Documents.QuantifierJudgment.cases.No.make({ quantifier: "none" }),
  },
])(
  "retains native decisive-answer ordering after uncertainty: $command",
  ({ command, choices, native }) =>
    Effect.gen(function* () {
      const result = yield* invoke(
        [
          "mem",
          command,
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
          "--format",
          "json",
        ],
        choices.map((choice) => [choice]),
      );
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([JSON.stringify(native)]);
      expect(result.requests).toHaveLength(2);
    }),
);

it.effect(
  "retains an earlier native quantifier clarification instead of scanning for a later member",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke(
        [
          "mem",
          "any",
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
          "--format",
          "json",
        ],
        [["multipleTarget0"], ["member"]],
      );
      expect(Result.isSuccess(result.outcome)).toBe(true);
      const expectedTarget = Documents.SetDocument.cases.Taxon.make({
        record: Documents.RecordDocument.make({ scientificName: TaxonName.make("Quercus") }),
      });
      const expected = Documents.QuantifierJudgment.cases.MultipleTaxaInTarget.make({
        quantifier: "any",
        target: expectedTarget,
      });
      expect(result.stdout).toEqual([JSON.stringify(expected)]);
      expect(result.requests).toHaveLength(1);
    }),
);

it.effect(
  "prints one header across bounded groups and retains the native concurrency grouping",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke(
        [
          "mem",
          "part",
          "--record",
          "A17",
          "--record",
          "B42",
          "--record",
          "C88",
          "--target",
          "Quercus",
          "--model",
          "custom/model",
          "--batch-size",
          "1",
          "--concurrency",
          "2",
        ],
        [["notMember"], ["member"], ["member"]],
      );
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([
        "judgment\trecord\tclarification_target",
        "Member\tB42\t",
        "NotMember\tA17\t",
        "Member\tC88\t",
      ]);
      expect(result.requests).toHaveLength(3);
    }),
);

it.effect("handles the empty target through the native primitive without a provider request", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      "part",
      "--record",
      "A17",
      "--model",
      "custom/model",
      "--format",
      "jsonl",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    const expectedRow = {
      record: "A17",
      judgment: Documents.MembershipJudgment.cases.NotMember.make({}),
    };
    expect(result.stdout).toEqual([JSON.stringify(expectedRow)]);
    expect(result.requests).toEqual([]);
  }),
);

it.effect("retains a delimiter-bearing record and the complete native judgment in JSONL", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      "check",
      "Voucher\tA17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
      "--format",
      "jsonl",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(['{"record":"Voucher\\tA17","judgment":{"_tag":"Member"}}']);
  }),
);

it.effect("checks one supplied record against a target with the native membership primitive", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "membership",
      "check",
      "Voucher A17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
    ]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([
      "judgment\trecord\tclarification_target",
      "Member\tVoucher A17\t",
    ]);
    expect(result.stderr).toEqual([]);
  }),
);
