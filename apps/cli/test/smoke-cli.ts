import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Deferred, Effect, Fiber, FileSystem, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const sentinel = "robo-taxonomist-build-only-sentinel-9ce19f6d";

const parseWireJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

const openApiContract = Schema.Struct({
  paths: Schema.Struct({ "/classify": Schema.Record(Schema.String, Schema.Unknown) }),
});

class ExitedBeforeReadiness extends Data.TaggedError("ExitedBeforeReadiness")<{
  readonly code: number;
  readonly diagnostics: string;
}> {}

const runCommand = Effect.fn("CliSmoke.runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, code] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, code };
}, Effect.scoped);

const verifyLocalEndpoints = Effect.fn("CliSmoke.verifyLocalEndpoints")(function* (
  address: string,
) {
  const labels = HttpClientRequest.post(`${address}/compare/labels`).pipe(
    HttpClientRequest.bodyText('{"left":"Voucher A17","right":"Voucher A17"}', "application/json"),
  );

  yield* Effect.gen(function* () {
    const response = yield* HttpClient.execute(labels);
    assert.equal(response.status, 200);
    const equal = yield* response.text.pipe(Effect.flatMap(parseWireJson));

    assert.equal(equal, true);
  }).pipe(Effect.timeout("5 seconds"));

  const metadata = "[".repeat(65) + "null" + "]".repeat(65);

  const deepRequest = HttpClientRequest.post(`${address}/sets/create`).pipe(
    HttpClientRequest.bodyText(
      `{"targets":[{"scientificName":"Quercus","metadata":${metadata}}]}`,
      "Application/JSON; charset=utf-8",
    ),
  );

  yield* Effect.gen(function* () {
    const response = yield* HttpClient.execute(deepRequest);
    assert.equal(response.status, 400);
    const actual = yield* response.text.pipe(Effect.flatMap(parseWireJson));
    const expected = yield* parseWireJson('{"_tag":"RequestTooDeep","maxJsonDepth":64}');

    assert.deepEqual(actual, expected);
  }).pipe(Effect.timeout("5 seconds"));

  yield* Effect.gen(function* () {
    const response = yield* HttpClient.get(`${address}/openapi.json`);
    assert.equal(response.status, 200);
    yield* response.text.pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(openApiContract))),
    );
  }).pipe(Effect.timeout("5 seconds"));
});

const verifyForegroundServer = Effect.fn("CliSmoke.verifyForegroundServer")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const ready = yield* Deferred.make<string>();

  const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped);

  const stderr = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.tap((line) => {
      const address = /http:\/\/127\.0\.0\.1:\d+(?=\s|$)/u.exec(line)?.[0];

      return address === undefined ? Effect.void : Deferred.succeed(ready, address);
    }),
    Stream.mkString,
    Effect.forkScoped,
  );

  const earlyExit = Effect.gen(function* () {
    const code = yield* child.exitCode;
    const diagnostics = yield* Fiber.join(stderr);

    return yield* new ExitedBeforeReadiness({ code, diagnostics });
  });

  const address = yield* Effect.raceFirst(Deferred.await(ready), earlyExit).pipe(
    Effect.timeout("5 seconds"),
  );

  yield* verifyLocalEndpoints(address);
  yield* child.kill({ killSignal: "SIGINT", forceKillAfter: "5 seconds" });

  const code = yield* child.exitCode;
  const output = yield* Fiber.join(stdout);
  yield* Fiber.join(stderr);

  assert.equal(code, 130);
  assert.equal(output, "");
  yield* HttpClient.get(address).pipe(Effect.flip, Effect.timeout("5 seconds"));
}, Effect.scoped);

const smoke = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const build = yield* runCommand(
    ChildProcess.make("pnpm", ["run", "cli:compile"], {
      env: { TYPESAFE_API_KEY: sentinel, ROBO_TAXONOMIST_MODEL: sentinel },
      extendEnv: true,
      stdin: "ignore",
      forceKillAfter: "2 seconds",
    }),
  ).pipe(Effect.timeout("30 seconds"));

  assert.equal(build.code, 0, `${build.stdout}\n${build.stderr}`);
  const artifact = resolve("artifacts/cli/robo-taxonomist");
  const bytes = yield* fs.readFile(artifact);
  assert.equal(
    Buffer.from(bytes).includes(sentinel),
    false,
    "build-time environment must not be embedded",
  );

  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "robo-taxonomist-executable-" });
  const executable = join(directory, "robo-taxonomist");
  yield* fs.copyFile(artifact, executable);
  yield* fs.chmod(executable, 0o755);

  const environment = { PATH: directory, HOME: directory, NO_COLOR: "1" };

  const options = {
    cwd: directory,
    env: environment,
    extendEnv: false,
    stdin: "ignore",
    forceKillAfter: "2 seconds",
  } satisfies ChildProcess.CommandOptions;

  const run = (args: readonly string[]) =>
    runCommand(ChildProcess.make(executable, args, options)).pipe(Effect.timeout("5 seconds"));

  const help = yield* run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /robo-taxonomist/u);
  assert.equal(help.stderr, "");

  const equal = yield* run(["compare", "labels", "Voucher A17", "Voucher A17"]);
  assert.deepEqual(equal, { stdout: "true\n", stderr: "", code: 0 });

  const different = yield* run(["compare", "labels", "Voucher A17", "Voucher B18"]);
  assert.deepEqual(different, { stdout: "false\n", stderr: "", code: 0 });

  yield* fs.writeFileString(
    join(directory, ".env"),
    `TYPESAFE_API_KEY=${sentinel}\nROBO_TAXONOMIST_MODEL=${sentinel}\n`,
  );

  const missingConfig = yield* run(["server", "--port", "0"]);
  assert.notEqual(missingConfig.code, 0);
  assert.equal(missingConfig.stdout, "");
  assert.match(missingConfig.stderr, /ROBO_TAXONOMIST_MODEL/u);
  assert.equal(missingConfig.stderr.includes(sentinel), false);

  yield* verifyForegroundServer(
    ChildProcess.make(executable, ["server", "--model", "fixture-model", "--port", "0"], {
      ...options,
      env: { ...environment, TYPESAFE_API_KEY: "fixture-key" },
    }),
  );
}).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer]));

await test("host executable runs without a JavaScript runtime or source checkout", () =>
  Effect.runPromise(smoke));
