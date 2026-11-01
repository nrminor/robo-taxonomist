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
  Effect.gen(function* () {
    const requests: (typeof wireRequest.Type)[] = [];
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
        const payload = Schema.decodeUnknownSync(wireRequest)(text);
        const choices = replies[requests.length] ?? ["member"];
        requests.push(payload);
        const answers = Object.fromEntries(
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
    return {
      outcome,
      requests,
      stdout: yield* TestConsole.logLines,
      stderr: yield* TestConsole.errorLines,
    };
  }).pipe(
    Effect.provide([
      NodeServices.layer,
      Stdio.layerTest({ stdin: Stream.succeed(new TextEncoder().encode(stdin)) }),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" })),
      Layer.fresh(TestConsole.layer),
    ]),
  );

it.effect("rejects delimiter-bearing membership TSV before emitting a header", () =>
  Effect.gen(function* () {
    const result = yield* invoke([
      "mem",
      "check",
      "Voucher\tA17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
    ]);
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toEqual([]);
    expect(JSON.stringify(result.stderr)).toContain("--format jsonl");
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    expect(result.stdout).toEqual([JSON.stringify({ record, judgment: { _tag: "Member" } })]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
      expect(result.requests.map(({ questions }) => Object.keys(questions))).toEqual([
        ["record0"],
        ["record0"],
      ]);
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
    expect(result.stdout).toEqual([
      '{"_tag":"MultipleTaxaInTarget","quantifier":"all","target":{"_tag":"Taxon","record":{"scientificName":"Quercus"}}}',
    ]);
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
    expect(result.stdout.map((line) => JSON.parse(String(line)))).toEqual([
      { record: "A17", judgment: { _tag: "Member" } },
      { record: "A17", judgment: { _tag: "Member" } },
      { record: "B42", judgment: { _tag: "NotMember" } },
      { record: "mixed", judgment: { _tag: "MixedMembership" } },
      { record: "unknown", judgment: { _tag: "Undetermined" } },
      {
        record: "review",
        judgment: {
          _tag: "MultipleTaxaInTarget",
          target: { _tag: "Taxon", record: { scientificName: "Quercus" } },
        },
      },
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
    expect(result.stdout.map((line) => JSON.parse(String(line)).record)).toEqual([
      first,
      "  A17  ",
      "A17",
      { label: "B42", metadata: { abundance: 2 } },
    ]);
    expect(JSON.stringify(result.requests[0]?.questions)).toContain("Record label:");
    expect(JSON.stringify(result.requests[0]?.questions)).not.toContain("Scientific name:");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
      expect(result.stdout).toEqual([JSON.stringify({ record, judgment: { _tag: "Member" } })]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { command: "all", tag: "Yes" },
  { command: "any", tag: "No" },
  { command: "none", tag: "Yes" },
])("retains native vacuous behavior on empty record inputs: $command", ({ command, tag }) =>
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
    expect(result.stdout).toEqual([JSON.stringify({ _tag: tag, quantifier: command })]);
    expect(result.requests).toEqual([]);
  }),
);

it.effect("emits just the invocation header for an empty partition", () =>
  Effect.gen(function* () {
    const result = yield* invoke(["mem", "part", "--target", "Quercus", "--model", "custom/model"]);
    expect(Result.isSuccess(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(["judgment\trecord\tclarification_target"]);
    expect(result.requests).toEqual([]);
  }),
);

it.effect("fails after an emitted prefix when a later record source cannot be read", () =>
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
      "--format",
      "jsonl",
    ]);
    expect(Result.isFailure(result.outcome)).toBe(true);
    expect(result.stdout).toEqual(['{"record":"A17","judgment":{"_tag":"Member"}}']);
    expect(JSON.stringify(result.stderr)).toContain(missing);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects delimiter-bearing quantifier clarification text with structured-output guidance",
  () =>
    Effect.gen(function* () {
      const result = yield* invoke(
        ["mem", "all", "--record", "A17", "--target", "Quercus\tFagus", "--model", "custom/model"],
        [["multipleTarget0"]],
      );
      expect(Result.isFailure(result.outcome)).toBe(true);
      expect(result.stdout).toEqual([]);
      expect(JSON.stringify(result.stderr)).toContain("--format json");
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
      expect(result.stdout).toEqual([JSON.stringify({ record, judgment: { _tag: "Member" } })]);
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
      expect(result.stdout).toEqual(['{"record":"A17","judgment":{"_tag":"Member"}}']);
      expect(JSON.stringify(result.stderr)).toContain("decision model request failed");
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
    expect(JSON.stringify(result.stderr)).toContain("Cannot serialize membership result");
  }),
);

it.effect.each([
  { command: "all", choices: ["undetermined", "mixed"], tag: "No" },
  { command: "any", choices: ["undetermined", "member"], tag: "Yes" },
  { command: "none", choices: ["undetermined", "member"], tag: "No" },
])(
  "retains native decisive-answer ordering after uncertainty: $command",
  ({ command, choices, tag }) =>
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
      expect(result.stdout).toEqual([JSON.stringify({ _tag: tag, quantifier: command })]);
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
      expect(result.stdout).toEqual([
        '{"_tag":"MultipleTaxaInTarget","quantifier":"any","target":{"_tag":"Taxon","record":{"scientificName":"Quercus"}}}',
      ]);
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
    expect(result.stdout).toEqual(['{"record":"A17","judgment":{"_tag":"NotMember"}}']);
    expect(result.requests).toEqual([]);
  }),
);

it.effect("retains a delimiter-bearing record and the complete native judgment in JSONL", () =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "test" })([
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
    expect(yield* TestConsole.logLines).toEqual([
      '{"record":"Voucher\\tA17","judgment":{"_tag":"Member"}}',
    ]);
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                model: "fixture-model",
                answers: {
                  record0: {
                    type: "choice",
                    choice: "member",
                    confidence: 1,
                    probabilities: {
                      member: 1,
                      notMember: 0,
                      mixed: 0,
                      undetermined: 0,
                      multipleTarget0: 0,
                    },
                  },
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    ),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" })),
    ),
    Effect.provide([NodeServices.layer, TestConsole.layer]),
  ),
);

it.effect("checks one supplied record against a target with the native membership primitive", () =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "test" })([
      "membership",
      "check",
      "Voucher A17",
      "--target",
      "Quercus",
      "--model",
      "custom/model",
    ]);
    expect(yield* TestConsole.logLines).toEqual([
      "judgment\trecord\tclarification_target",
      "Member\tVoucher A17\t",
    ]);
    expect(yield* TestConsole.errorLines).toEqual([]);
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                model: "fixture-model",
                answers: {
                  record0: {
                    type: "choice",
                    choice: "member",
                    confidence: 1,
                    probabilities: {
                      member: 1,
                      notMember: 0,
                      mixed: 0,
                      undetermined: 0,
                      multipleTarget0: 0,
                    },
                  },
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    ),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "fixture-key" })),
    ),
    Effect.provide([NodeServices.layer, TestConsole.layer]),
  ),
);
