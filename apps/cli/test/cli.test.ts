import { dirname } from "node:path";
import { execPath } from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const run = Effect.fn("CliTest.run")(
  function* (args: readonly string[], entry = "src/main.ts") {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(execPath, [entry, ...args], {
        env: { NO_COLOR: "1" },
        extendEnv: false,
        stdin: "ignore",
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
    expect(yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)).toBe("true\n");
    expect(yield* child.exitCode).toBe(0);
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
    expect(result.stdout).toContain("0.0.0");
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
