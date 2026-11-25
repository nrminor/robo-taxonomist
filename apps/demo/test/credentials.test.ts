// @vitest-environment node
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import * as TestJson from "./Json.ts";

const cli = fileURLToPath(new URL("../node_modules/varlock/bin/cli.js", import.meta.url));

const envSchema = fileURLToPath(new URL("../.env.schema", import.meta.url));

const account = "0123456789abcdef0123456789abcdef";

const token = "DUMMY_TOKEN_FOR_ISOLATED_CLI_TEST_ONLY_123456789";

const decodeAgentOutput = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      DEMO_MODEL: Schema.Literal("clef"),
      CLOUDFLARE_ACCOUNT_ID: Schema.String,
      CLOUDFLARE_API_TOKEN: Schema.String,
    }),
  ),
  { onExcessProperty: "error" },
);

const runCli = Effect.fn("VarlockTest.runCli")(
  function* (args: readonly string[], credentials: Readonly<Record<string, string>> = {}) {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "demo-credentials-" });
    yield* fs.copyFile(envSchema, join(directory, ".env.schema"));

    const child = yield* spawner.spawn(
      ChildProcess.make(execPath, [cli, ...args], {
        cwd: directory,
        env: {
          HOME: directory,
          NODE_ENV: "test",
          VARLOCK_TELEMETRY_DISABLED: "1",
          DO_NOT_TRACK: "1",
          ...credentials,
        },
        extendEnv: false,
        stdin: "ignore",
        forceKillAfter: "500 millis",
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
  Effect.timeout("3 seconds"),
  Effect.provide(NodeServices.layer),
);

it.live("rejects missing required credentials before starting the child", () =>
  Effect.gen(function* () {
    const result = yield* runCli([
      "run",
      "--inject",
      "vars",
      "--",
      execPath,
      "-e",
      "console.log('CHILD_STARTED')",
    ]);

    const output = result.stdout + result.stderr;
    expect(result.code).toBe(1);
    expect(output).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(output).toContain("CLOUDFLARE_API_TOKEN");
    expect(output).toMatch(/required/i);
    expect(output).not.toContain("CHILD_STARTED");
  }),
);

it.live("injects only vars into the child and redacts its piped output", () =>
  Effect.gen(function* () {
    const accountText = yield* TestJson.encode(account);
    const tokenText = yield* TestJson.encode(token);

    const child = `
      const assert = require('node:assert/strict');
      assert.equal(process.env.DEMO_MODEL, 'clef');
      assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ${accountText});
      assert.equal(process.env.CLOUDFLARE_API_TOKEN, ${tokenText});
      assert.equal(Object.hasOwn(process.env, '__VARLOCK_ENV'), false);
      console.log('CHILD_ASSERTIONS_PASSED');
      console.log(process.env.CLOUDFLARE_API_TOKEN);
      console.error(process.env.CLOUDFLARE_API_TOKEN);
      console.log('CHILD_FINISHED');
    `;

    const result = yield* runCli(["run", "--inject", "vars", "--", execPath, "-e", child], {
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: token,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CHILD_ASSERTIONS_PASSED");
    expect(result.stdout).toContain("CHILD_FINISHED");
    expect(result.stdout).toContain("▒");
    expect(result.stderr).toContain("▒");
    expect(result.stdout + result.stderr).not.toContain(token);
  }),
);

it.live.each([
  { name: "invalid account ID", account: "invalid", token },
  { name: "whitespace in token", account, token: "DUMMY token with invalid spaces 123456789" },
])("rejects invalid configuration before starting the child: $name", ({ account, token }) =>
  Effect.gen(function* () {
    const result = yield* runCli(
      ["run", "--inject", "vars", "--", execPath, "-e", "console.log('CHILD_STARTED')"],
      {
        CLOUDFLARE_ACCOUNT_ID: account,
        CLOUDFLARE_API_TOKEN: token,
      },
    );

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("CHILD_STARTED");
    expect(result.stdout + result.stderr).not.toContain(token);
  }),
);

it.live("keeps account metadata but redacts the token in agent output", () =>
  Effect.gen(function* () {
    const result = yield* runCli(["load", "--agent"], {
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: token,
    });

    expect(result.code).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(output).toContain(account);
    expect(output).toContain("CLOUDFLARE_API_TOKEN");
    expect(output).toContain("clef");
    expect(output).not.toContain(token);
    const agent = yield* decodeAgentOutput(result.stdout);
    expect(agent.CLOUDFLARE_ACCOUNT_ID).toBe(account);
    expect(agent.CLOUDFLARE_API_TOKEN).toContain("▒");
  }),
);
