import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const sentinel = "robo-taxonomist-build-only-sentinel-9ce19f6d";

await test(
  "host executable runs without a JavaScript runtime or source checkout",
  { timeout: 60_000 },
  async (t) => {
    await run("pnpm", ["run", "cli:compile"], {
      env: { ...process.env, TYPESAFE_API_KEY: sentinel, ROBO_TAXONOMIST_MODEL: sentinel },
      timeout: 30_000,
    });
    const artifact = resolve("artifacts/cli/robo-taxonomist");
    const bytes = await readFile(artifact);
    assert.equal(
      bytes.includes(Buffer.from(sentinel)),
      false,
      "build-time environment must not be embedded",
    );

    const directory = await mkdtemp(join(tmpdir(), "robo-taxonomist-executable-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = join(directory, "robo-taxonomist");
    await copyFile(artifact, executable);
    await chmod(executable, 0o755);
    const environment = { PATH: directory, HOME: directory, NO_COLOR: "1" };
    const options = { cwd: directory, env: environment, timeout: 5_000 };

    await t.test(
      "help and pure operations need neither credentials nor external files",
      async () => {
        const help = await run(executable, ["--help"], options);
        assert.match(help.stdout, /robo-taxonomist/u);
        assert.equal(help.stderr, "");
        const equal = await run(
          executable,
          ["compare", "labels", "Voucher A17", "Voucher A17"],
          options,
        );
        assert.equal(equal.stdout, "true\n");
        assert.equal(equal.stderr, "");
        const different = await run(
          executable,
          ["compare", "labels", "Voucher A17", "Voucher B18"],
          options,
        );
        assert.equal(different.stdout, "false\n");
        assert.equal(different.stderr, "");
      },
    );

    await t.test(
      "runtime configuration stays explicit and ignores local dotenv files",
      async () => {
        await writeFile(
          join(directory, ".env"),
          `TYPESAFE_API_KEY=${sentinel}\nROBO_TAXONOMIST_MODEL=${sentinel}\n`,
        );
        await assert.rejects(run(executable, ["server", "--port", "0"], options), (error) => {
          assert.notEqual(error.code, 0);
          assert.equal(error.stdout, "");
          assert.match(error.stderr, /ROBO_TAXONOMIST_MODEL/u);
          assert.equal(error.stderr.includes(sentinel), false);
          return true;
        });
      },
    );

    await t.test(
      "foreground server serves local operations and releases its socket on SIGINT",
      async (t) => {
        const child = spawn(executable, ["server", "--model", "fixture-model", "--port", "0"], {
          cwd: directory,
          env: { ...environment, TYPESAFE_API_KEY: "fixture-key" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const exit = once(child, "close");
        t.after(async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await exit;
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8");
        let diagnostics = "";
        const readiness = Promise.withResolvers();
        const timeout = AbortSignal.timeout(5_000);
        timeout.addEventListener("abort", () => readiness.reject(timeout.reason), { once: true });
        child.stderr.on("data", (chunk) => {
          diagnostics += chunk;
          const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(diagnostics);
          if (match !== null) readiness.resolve(match[0]);
        });
        const address = await Promise.race([
          readiness.promise,
          exit.then(() => {
            throw new Error(`Server exited before readiness: ${diagnostics}`);
          }),
        ]);
        const response = await fetch(`${address}/compare/labels`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ left: "Voucher A17", right: "Voucher A17" }),
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 200);
        assert.equal(await response.json(), true);
        const specification = await fetch(`${address}/openapi.json`, {
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(specification.status, 200);
        const contract = await specification.json();
        assert.ok(contract.paths["/classify"]);

        child.kill("SIGINT");
        const [code, signal] = await exit;
        assert.equal(signal, null);
        assert.equal(code, 130);
        assert.equal(stdout, "");
        await assert.rejects(fetch(address, { signal: AbortSignal.timeout(5_000) }));
      },
    );
  },
);
