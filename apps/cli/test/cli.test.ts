import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { execPath } from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import appPackage from "../package.json" with { type: "json" };

const run = Effect.fn("CliTest.run")(
  function* (args: readonly string[], entry = "src/main.ts", stdin?: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(execPath, [entry, ...args], {
        env: { NO_COLOR: "1" },
        extendEnv: false,
        stdin: stdin === undefined ? "ignore" : Stream.succeed(new TextEncoder().encode(stdin)),
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code };
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

it.effect("compares identical labels without model configuration", () =>
  Effect.gen(function* () {
    const result = yield* run(["compare", "labels", "Voucher A17", "Voucher A17"]);
    expect(result).toEqual({ stdout: "true\n", stderr: "", code: 0 });
  }),
);

it.effect("fails with a diagnostic when the primary stdout reader is closed", () =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(
      () =>
        new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(execPath, ["src/main.ts", "compare", "labels", "A17", "A17"], {
            env: { NO_COLOR: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
          child.stdout.destroy();
        }),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Cannot write results to stdout");
  }),
);

it.effect("reports missing provider credentials on stderr without starting inference", () =>
  Effect.gen(function* () {
    const result = yield* run([
      "compare",
      "identity",
      "Quercus",
      "Fagus",
      "--model",
      "custom/model",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("TYPESAFE_API_KEY");
  }),
);

it.effect("shows foreground server configuration without acquiring credentials", () =>
  Effect.gen(function* () {
    const result = yield* run(["server", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const flag of [
      "--host",
      "--port",
      "--max-body-bytes",
      "--request-timeout-ms",
      "--max-json-depth",
      "--max-records",
      "--max-targets",
      "--max-record-target-pairs",
      "--batch-size",
      "--concurrency",
      "--model",
    ]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain("127.0.0.1");
    expect(result.stdout).toContain("TYPESAFE_API_KEY");
    for (const [flag, value] of [
      ["--host", "127.0.0.1"],
      ["--port", "3000"],
      ["--max-body-bytes", "1048576"],
      ["--request-timeout-ms", "60000"],
      ["--max-json-depth", "64"],
      ["--max-records", "1000"],
      ["--max-targets", "100"],
      ["--max-record-target-pairs", "10000"],
      ["--batch-size", "16"],
      ["--concurrency", "1"],
    ] as const) {
      const option = result.stdout
        .split("\n")
        .find((line) => line.trimStart().startsWith(`${flag} `));
      expect(option).toContain(value);
    }
  }),
);

it.effect.each([
  { args: ["server"], configuration: "ROBO_TAXONOMIST_MODEL" },
  { args: ["server", "--model", "fixture-model"], configuration: "TYPESAFE_API_KEY" },
])(
  "requires startup model configuration before binding a server: $configuration",
  ({ args, configuration }) =>
    Effect.gen(function* () {
      const result = yield* run(args);

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(configuration);
    }),
);

it.effect.each([
  { flag: "--port", value: "65536" },
  { flag: "--max-body-bytes", value: "0" },
  { flag: "--request-timeout-ms", value: "0" },
  { flag: "--max-json-depth", value: "0" },
  { flag: "--max-records", value: "0" },
  { flag: "--max-targets", value: "0" },
  { flag: "--max-record-target-pairs", value: "0" },
  { flag: "--batch-size", value: "0" },
  { flag: "--concurrency", value: "0" },
  { flag: "--host", value: "" },
])("rejects invalid server settings before startup: $flag", ({ flag, value }) =>
  Effect.gen(function* () {
    const result = yield* run(["server", "--model", "fixture-model", flag, value]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(flag);
  }),
);

it.effect.each([
  { path: ["compare", "identity"] },
  { path: ["compare", "rank"] },
  { path: ["cmp", "within"] },
  { path: ["set", "relation"] },
  { path: ["membership", "check"] },
  { path: ["mem", "part"] },
  { path: ["mem", "all"] },
  { path: ["mem", "any"] },
  { path: ["mem", "none"] },
  { path: ["classify"] },
  { path: ["cls"] },
])("shows model-backed command help without configuration or credentials: $path", ({ path }) =>
  Effect.gen(function* () {
    const result = yield* run([...path, "--help"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    for (const text of [
      "--model",
      "ROBO_TAXONOMIST_MODEL",
      "TYPESAFE_API_KEY",
      "--format",
      "--no-header",
    ]) {
      expect(result.stdout).toContain(text);
    }
  }),
);

it.effect("requires model selection instead of inventing a default", () =>
  Effect.gen(function* () {
    const result = yield* run(["compare", "identity", "Quercus", "Fagus"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ROBO_TAXONOMIST_MODEL");
  }),
);

it.effect.each([
  { args: ["compare", "identity", "Quercus", "Fagus", "--model", "   "] },
  { args: ["compare", "identity", "Quercus", "Fagus", "Betula", "--model", "custom/model"] },
  { args: ["compare", "containment", "Quercus", "Fagaceae", "Betula", "--model", "custom/model"] },
  { args: ["compare", "rank", "A17", "B42", "--model", "custom/model"] },
  { args: ["compare", "rank", "A17", "B42", "--rank", "strain", "--model", "custom/model"] },
])("rejects invalid scalar arity or configuration without primary output: $args", ({ args }) =>
  Effect.gen(function* () {
    const result = yield* run(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  }),
);

it.effect("constructs a symbolic taxon set without model configuration", () =>
  Effect.gen(function* () {
    const result = yield* run(["set", "create", "--target", "Quercus"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Taxon",
      record: { scientificName: "Quercus" },
    });
  }),
);

it.effect("preserves repeated target occurrences and exact names in one flat union", () =>
  Effect.gen(function* () {
    const result = yield* run([
      "set",
      "create",
      "--target",
      " Quercus ",
      "--target",
      "Fagus",
      "--target",
      " Quercus ",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Union",
      operands: [
        { _tag: "Taxon", record: { scientificName: " Quercus " } },
        { _tag: "Taxon", record: { scientificName: "Fagus" } },
        { _tag: "Taxon", record: { scientificName: " Quercus " } },
      ],
    });
  }),
);

it.effect(
  "constructs ten thousand newline targets without a serialization crash or diagnostic stdout",
  () =>
    Effect.gen(function* () {
      const result = yield* run(
        ["set", "create", "--targets-file", "-"],
        undefined,
        "Quercus\n".repeat(10_000),
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const document = JSON.parse(result.stdout);
      expect(document.operands).toHaveLength(10_000);
      expect(document.operands[0]).toEqual({
        _tag: "Taxon",
        record: { scientificName: "Quercus" },
      });
      expect(document.operands[9_999]).toEqual({
        _tag: "Taxon",
        record: { scientificName: "Quercus" },
      });
      const restored = yield* run(
        ["set", "create", "--targets-file", "-", "--targets-format", "json"],
        undefined,
        result.stdout,
      );
      expect(restored).toEqual(result);
    }),
);

it.effect("fails excessively nested imported expressions cleanly on stderr", () =>
  Effect.gen(function* () {
    const document =
      '{"_tag":"Union","operands":['.repeat(6_000) +
      '{"_tag":"Taxon","record":{"scientificName":"Quercus"}}' +
      ',{"_tag":"Empty"}]}'.repeat(6_000);
    const result = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "json"],
      undefined,
      document,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stdin");
    expect(result.stderr).toContain("too deeply nested");
  }),
);

it.effect("reports excessively nested JSONL metadata without diagnostic stdout", () =>
  Effect.gen(function* () {
    const document =
      '{"scientificName":"Quercus","metadata":' +
      '{"child":'.repeat(20_000) +
      "null" +
      "}".repeat(20_000) +
      "}\n";
    const result = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "jsonl"],
      undefined,
      document,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot serialize output");
  }),
);

it.effect("reads ordinary newline targets from stdin without a format flag", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ["set", "create", "--targets-file", "-"],
      undefined,
      "Quercus\r\n Fagus \n",
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Union",
      operands: [
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
        { _tag: "Taxon", record: { scientificName: " Fagus " } },
      ],
    });
  }),
);

it.effect("reports an invalid target's input line on stderr without emitting a set", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ["set", "create", "--targets-file", "-"],
      undefined,
      "Quercus\n   \nFagus\n",
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stdin:2");
  }),
);

it.effect(
  "reads literal targets first, then files in their supplied order without sniffing literals",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const first = `${directory}/first.txt`;
      const second = `${directory}/second.txt`;
      yield* fs.writeFileString(first, "Quercus\n");
      yield* fs.writeFileString(second, "Fagus\n");
      const result = yield* run([
        "set",
        "create",
        "--targets-file",
        first,
        "--target",
        first,
        "--targets-file",
        second,
      ]);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        _tag: "Union",
        operands: [
          { _tag: "Taxon", record: { scientificName: first } },
          { _tag: "Taxon", record: { scientificName: "Quercus" } },
          { _tag: "Taxon", record: { scientificName: "Fagus" } },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads structured target stdin when explicitly selected and preserves arbitrary JSON metadata",
  () =>
    Effect.gen(function* () {
      const record = {
        taxonId: { taxonomy: "ncbi", id: "9606", release: "2026", curator: { name: "caller" } },
        sample: "A17",
        abundance: 7.5,
        metadata: { flags: [true, null, "unchanged"] },
      };
      const result = yield* run(
        ["set", "create", "--targets-file", "-", "--targets-format", "json"],
        undefined,
        JSON.stringify([record, record]),
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        _tag: "Union",
        operands: [
          { _tag: "Taxon", record },
          { _tag: "Taxon", record },
        ],
      });
    }),
);

it.effect("fails structured target decoding without falling back to a text name", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "json"],
      undefined,
      "not JSON\n",
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stdin");
    expect(result.stderr).toContain("JSON");
  }),
);

it.effect("uses a named file's JSON suffix unless an explicit encoding overrides it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/targets.json`;
    yield* fs.writeFileString(path, '[{"label":"Voucher A17","abundance":3}]');
    const detected = yield* run(["set", "create", "--targets-file", path]);
    expect(detected).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(detected.stdout)).toEqual({
      _tag: "Taxon",
      record: { label: "Voucher A17", abundance: 3 },
    });
    const overridden = yield* run([
      "set",
      "create",
      "--targets-file",
      path,
      "--targets-format",
      "text",
    ]);
    expect(overridden).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(overridden.stdout)).toEqual({
      _tag: "Taxon",
      record: { scientificName: '[{"label":"Voucher A17","abundance":3}]' },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reloads generated multi-operand union artifacts through structured target stdin", () =>
  Effect.gen(function* () {
    const created = yield* run([
      "set",
      "create",
      "--target",
      "Quercus",
      "--target",
      "Fagus",
      "--target",
      "Quercus",
    ]);
    expect(created).toMatchObject({ code: 0, stderr: "" });
    const restored = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "json"],
      undefined,
      created.stdout,
    );
    expect(restored).toEqual(created);
  }),
);

it.effect("constructs a directed difference from explicit left and right targets", () =>
  Effect.gen(function* () {
    const result = yield* run([
      "set",
      "difference",
      "--left-target",
      "Fagaceae",
      "--right-target",
      "Quercus",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Difference",
      left: { _tag: "Taxon", record: { scientificName: "Fagaceae" } },
      right: { _tag: "Taxon", record: { scientificName: "Quercus" } },
    });
  }),
);

it.effect("unions two supplied set operands without simplifying repeated targets", () =>
  Effect.gen(function* () {
    const result = yield* run([
      "set",
      "union",
      "--left-target",
      "Quercus",
      "--right-target",
      "Quercus",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Union",
      operands: [
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
      ],
    });
  }),
);

it.effect("intersects sets while retaining their native binary structure", () =>
  Effect.gen(function* () {
    const result = yield* run([
      "set",
      "intersection",
      "--left-target",
      "Fagaceae",
      "--right-target",
      "Quercus",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Intersection",
      operands: [
        { _tag: "Taxon", record: { scientificName: "Fagaceae" } },
        { _tag: "Taxon", record: { scientificName: "Quercus" } },
      ],
    });
  }),
);

it.effect("rejects shared stdin before reading either set operand", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ["set", "difference", "--left-targets-file", "-", "--right-targets-file", "-"],
      undefined,
      "Quercus\n",
    );
    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("stdin can only be used once");
  }),
);

it.effect("reads identifying target records from a JSONL file without dropping metadata", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/targets.jsonl`;
    const first = { scientificName: "Quercus", notes: [1, null] };
    const second = { label: "voucher", scientificName: "Fagus", observed: { sample: "B" } };
    yield* fs.writeFileString(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const result = yield* run(["set", "create", "--targets-file", path]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Union",
      operands: [
        { _tag: "Taxon", record: first },
        { _tag: "Taxon", record: second },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports unreadable target sources on stderr without emitting an artifact", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/missing.txt`;
    const result = yield* run(["set", "create", "--targets-file", path]);
    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain("Cannot read target source");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { document: [{ sample: "unidentified" }] },
  { document: [{ label: " " }] },
  { document: [{ scientificName: "" }] },
  { document: [{ taxonId: { taxonomy: "ncbi" } }] },
  { document: { _tag: "Union", operands: [] } },
  { document: { _tag: "Union", operands: [{ _tag: "Empty" }] } },
  { document: { _tag: "Intersection", operands: [{ _tag: "Empty" }] } },
  {
    document: {
      _tag: "Intersection",
      operands: [{ _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }],
    },
  },
])("rejects unidentified targets and unsupported artifact arities: $document", ({ document }) =>
  Effect.gen(function* () {
    const result = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "json"],
      undefined,
      JSON.stringify(document),
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stdin");
  }),
);

it.effect("accepts the concise diff alias with the same directed operands", () =>
  Effect.gen(function* () {
    const result = yield* run([
      "set",
      "diff",
      "--left-target",
      "Fagaceae",
      "--right-target",
      "Quercus",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Difference",
      left: { _tag: "Taxon", record: { scientificName: "Fagaceae" } },
      right: { _tag: "Taxon", record: { scientificName: "Quercus" } },
    });
  }),
);

it.effect("composes and reloads nested artifacts while retaining metadata and operand order", () =>
  Effect.gen(function* () {
    const record = { scientificName: "Fagaceae", metadata: { source: [null, "caller"] } };
    const created = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "json"],
      undefined,
      JSON.stringify([record]),
    );
    expect(created.code).toBe(0);
    const difference = yield* run(
      [
        "set",
        "difference",
        "--left-targets-file",
        "-",
        "--left-targets-format",
        "json",
        "--right-target",
        "Quercus",
      ],
      undefined,
      created.stdout,
    );
    expect(difference).toMatchObject({ code: 0, stderr: "" });
    const intersection = yield* run(
      [
        "set",
        "intersection",
        "--left-target",
        "Fagus",
        "--right-targets-file",
        "-",
        "--right-targets-format",
        "json",
      ],
      undefined,
      difference.stdout,
    );
    expect(intersection).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(intersection.stdout)).toEqual({
      _tag: "Intersection",
      operands: [
        { _tag: "Taxon", record: { scientificName: "Fagus" } },
        {
          _tag: "Difference",
          left: { _tag: "Taxon", record },
          right: { _tag: "Taxon", record: { scientificName: "Quercus" } },
        },
      ],
    });
    const restored = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "json"],
      undefined,
      intersection.stdout,
    );
    expect(restored).toEqual(intersection);
  }),
);

it.effect.each([
  { args: ["set", "create"], stdin: undefined },
  { args: ["set", "create", "--targets-file", "-"], stdin: "" },
  { args: ["set", "create", "--targets-file", "-", "--targets-format", "json"], stdin: "[]" },
])("constructs an empty set from empty sources: $args", ({ args, stdin }) =>
  Effect.gen(function* () {
    const result = yield* run(args, undefined, stdin);
    expect(result).toEqual({ stdout: '{"_tag":"Empty"}\n', stderr: "", code: 0 });
  }),
);

it.effect("does not sniff JSON-looking stdin when text encoding is the default", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ["set", "create", "--targets-file", "-"],
      undefined,
      '[{"scientificName":"Quercus"}]\n',
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      _tag: "Taxon",
      record: { scientificName: '[{"scientificName":"Quercus"}]' },
    });
  }),
);

it.effect("shows target formats, saved sets and an example in create help", () =>
  Effect.gen(function* () {
    const result = yield* run(["set", "create", "--help"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    for (const text of [
      "--targets-file",
      ".json",
      ".jsonl",
      "stdin defaults to text",
      "JSON",
      "--target Quercus",
    ]) {
      expect(result.stdout).toContain(text);
    }
  }),
);

it.effect.each(["difference", "union", "intersection"] as const)(
  "teaches both operands' source rules in %s help",
  (operation) =>
    Effect.gen(function* () {
      const result = yield* run(["set", operation, "--help"]);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      for (const text of ["--left-target", "--right-targets-file", ".jsonl", "JSON", "stdin"]) {
        expect(result.stdout).toContain(text);
      }
    }),
);

it.effect("reports the failing JSONL record line instead of treating it as a target name", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ["set", "create", "--targets-file", "-", "--targets-format", "jsonl"],
      undefined,
      '{"scientificName":"Quercus"}\n{"sample":"unidentified"}\n',
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stdin:2");
  }),
);

it.effect.each([
  { args: ["set", "create", "--targets-file", "-", "--targets-file", "-"] },
  { args: ["set", "union", "--left-targets-file", "-", "--right-targets-file", "-"] },
  { args: ["set", "intersection", "--left-targets-file", "-", "--right-targets-file", "-"] },
])("rejects duplicate stdin across target sources: $args", ({ args }) =>
  Effect.gen(function* () {
    const result = yield* run(args, undefined, "Quercus\n");
    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("stdin can only be used once");
  }),
);

it.effect("rejects a blank label without writing primary output", () =>
  Effect.gen(function* () {
    const result = yield* run(["compare", "labels", "   ", "Voucher A17"]);
    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("nonblank record label");
  }),
);

it.effect("accepts cmp as the compare command alias", () =>
  Effect.gen(function* () {
    const result = yield* run(["cmp", "labels", "Voucher A17", "Voucher A17"]);
    expect(result).toEqual({ stdout: "true\n", stderr: "", code: 0 });
  }),
);

it.effect("runs the built JavaScript executable entry", () =>
  Effect.gen(function* () {
    const result = yield* run(["compare", "labels", "Voucher A17", "Voucher A17"], "dist/main.js");
    expect(result).toEqual({ stdout: "true\n", stderr: "", code: 0 });
  }),
);

it.effect("runs the executable bin entry through its shebang", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("./dist/main.js", ["compare", "labels", "A17", "A17"], {
        env: { PATH: dirname(execPath), NO_COLOR: "1" },
        extendEnv: false,
        stdin: "ignore",
      }),
    );
    const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    expect(stdout).toBe("true\n");

    const exitCode = yield* child.exitCode;
    expect(exitCode).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("shows help without credentials or interaction and offers the opt-in wizard", () =>
  Effect.gen(function* () {
    const result = yield* run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("robo-taxonomist");
    expect(result.stdout).toContain("compare");
    expect(result.stdout).toContain("--wizard");
  }),
);

it.effect.each([
  { path: [], commands: ["compare", "set", "membership", "classify", "server"] },
  { path: ["compare"], commands: ["labels", "identity", "rank", "containment"] },
  { path: ["set"], commands: ["create", "difference", "union", "intersection", "relation"] },
  { path: ["membership"], commands: ["check", "partition", "all", "any", "none"] },
])("keeps the $path command menu to one summary line per subcommand", ({ path, commands }) =>
  Effect.gen(function* () {
    const result = yield* run([...path, "--help"]);
    const menu = result.stdout.split("SUBCOMMANDS\n")[1];

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(menu).toBeDefined();
    const entries = menu
      ?.trimEnd()
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(entries).toHaveLength(commands.length);
    for (const command of commands) {
      expect(entries?.some((line) => line.startsWith(`  ${command}`))).toBe(true);
    }
  }),
);

it.effect.each([
  { path: ["classify"] },
  { path: ["server"] },
  { path: ["membership", "partition"] },
  { path: ["membership", "all"] },
])("shows options and examples in $path help", ({ path }) =>
  Effect.gen(function* () {
    const result = yield* run([...path, "--help"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("EXAMPLES");
    expect(result.stdout).toContain("--model");
  }),
);

it.effect("preserves label whitespace when testing equality", () =>
  Effect.gen(function* () {
    const result = yield* run(["compare", "labels", "Voucher A17 ", "Voucher A17"]);
    expect(result).toEqual({ stdout: "false\n", stderr: "", code: 0 });
  }),
);

it.effect("reports the application version without credentials", () =>
  Effect.gen(function* () {
    const result = yield* run(["--version"]);
    expect(result).toMatchObject({ stderr: "", code: 0 });
    expect(result.stdout).toContain(appPackage.version);
  }),
);

it.effect("shows group help without executing a comparison", () =>
  Effect.gen(function* () {
    const result = yield* run(["compare"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("USAGE");
  }),
);

it.effect.each([
  { args: ["compare", "labels", "Voucher A17"] },
  { args: ["compare", "labels", "Voucher A17", "Voucher B42", "Voucher C99"] },
  { args: ["compare", "labels", "Voucher A17", "Voucher B42", "--unknown"] },
])("rejects invalid operands or flags without primary output: $args", ({ args }) =>
  Effect.gen(function* () {
    const result = yield* run(args);
    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe("");
  }),
);
