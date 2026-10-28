// @vitest-environment node
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/varlock/bin/cli.js", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const token = "DUMMY_TOKEN_FOR_ISOLATED_CLI_TEST_ONLY_123456789";

const cliDirectory = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "demo-credentials-"))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
  yield* Effect.sync(() =>
    copyFileSync(new URL("../.env.schema", import.meta.url), join(directory, ".env.schema")),
  );
  return directory;
});

const runCli = (directory: string, args: string[], env: Record<string, string> = {}) =>
  Effect.sync(() =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: directory,
      env: {
        HOME: directory,
        NODE_ENV: "test",
        VARLOCK_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
        ...env,
      },
      encoding: "utf8",
      timeout: 15_000,
    }),
  );

it.effect(
  "rejects missing required credentials before starting the child",
  () =>
    Effect.gen(function* () {
      const directory = yield* cliDirectory;
      const result = yield* runCli(directory, [
        "run",
        "--inject",
        "vars",
        "--",
        process.execPath,
        "-e",
        "console.log('CHILD_STARTED')",
      ]);
      const output = result.stdout + result.stderr;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(output).toContain("CLOUDFLARE_API_TOKEN");
      expect(output).toMatch(/required/i);
      expect(output).not.toContain("CHILD_STARTED");
    }),
  20_000,
);

it.effect(
  "injects only vars into the child and redacts its piped output",
  () =>
    Effect.gen(function* () {
      const directory = yield* cliDirectory;
      const child = `
      const assert = require('node:assert/strict');
      assert.equal(process.env.DEMO_MODEL, 'clef');
      assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ${JSON.stringify(account)});
      assert.equal(process.env.CLOUDFLARE_API_TOKEN, ${JSON.stringify(token)});
      assert.equal(Object.hasOwn(process.env, '__VARLOCK_ENV'), false);
      console.log('CHILD_ASSERTIONS_PASSED');
      console.log(process.env.CLOUDFLARE_API_TOKEN);
      console.error(process.env.CLOUDFLARE_API_TOKEN);
      console.log('CHILD_FINISHED');
    `;
      const result = yield* runCli(
        directory,
        ["run", "--inject", "vars", "--", process.execPath, "-e", child],
        {
          CLOUDFLARE_ACCOUNT_ID: account,
          CLOUDFLARE_API_TOKEN: token,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("CHILD_ASSERTIONS_PASSED");
      expect(result.stdout).toContain("CHILD_FINISHED");
      expect(result.stdout).toContain("▒");
      expect(result.stderr).toContain("▒");
      expect(result.stdout + result.stderr).not.toContain(token);
    }),
  20_000,
);

it.effect.each([
  { name: "invalid account ID", account: "invalid", token },
  { name: "whitespace in token", account, token: "DUMMY token with invalid spaces 123456789" },
])(
  "rejects invalid configuration before starting the child: $name",
  ({ account, token }) =>
    Effect.gen(function* () {
      const directory = yield* cliDirectory;
      const result = yield* runCli(
        directory,
        ["run", "--inject", "vars", "--", process.execPath, "-e", "console.log('CHILD_STARTED')"],
        {
          CLOUDFLARE_ACCOUNT_ID: account,
          CLOUDFLARE_API_TOKEN: token,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("CHILD_STARTED");
      expect(result.stdout + result.stderr).not.toContain(token);
    }),
  20_000,
);

it.effect(
  "keeps account metadata but redacts the token in agent output",
  () =>
    Effect.gen(function* () {
      const directory = yield* cliDirectory;
      const result = yield* runCli(directory, ["load", "--agent"], {
        CLOUDFLARE_ACCOUNT_ID: account,
        CLOUDFLARE_API_TOKEN: token,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(output).toContain(account);
      expect(output).toContain("CLOUDFLARE_API_TOKEN");
      expect(output).toContain("clef");
      expect(output).not.toContain(token);
      expect(JSON.parse(result.stdout)).toEqual({
        DEMO_MODEL: "clef",
        CLOUDFLARE_ACCOUNT_ID: account,
        CLOUDFLARE_API_TOKEN: expect.stringContaining("▒"),
      });
    }),
  20_000,
);
