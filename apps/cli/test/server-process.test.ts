import { execPath } from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Option, Ref, Result, Stream, String } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Api from "../src/api.ts";
import { RecordLabel } from "robo-taxonomist";

const environment = { NO_COLOR: "1", TYPESAFE_API_KEY: "fixture-key" };

const startServer = Effect.fn("ServerTest.startServer")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(
    execPath,
    ["src/main.ts", "server", "--model", "fixture-model", "--port", "0"],
    { env: environment, extendEnv: false, stdin: "ignore" },
  );
  const child = yield* spawner.spawn(command);
  const stdout = yield* Ref.make("");
  const stderr = yield* Ref.make("");
  const ready = yield* Deferred.make<string>();

  const collectOutput = child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(stdout, (text) => text + chunk)),
  );
  const readReadiness = child.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        yield* Ref.update(stderr, (text) => text + line + "\n");
        const address = String.match(/http:\/\/127\.0\.0\.1:\d+/u)(line);

        yield* Option.match(address, {
          onNone: () => Effect.void,
          onSome: (match) => Deferred.succeed(ready, match[0]),
        });
      }),
    ),
  );

  yield* Effect.forkScoped(collectOutput);
  yield* Effect.forkScoped(readReadiness);
  const baseUrl = yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"));

  return { child, baseUrl, stdout, stderr };
});

it.live("reports foreground readiness on stderr and shuts down when interrupted", () =>
  Effect.gen(function* () {
    const server = yield* startServer();
    const client = yield* HttpApiClient.make(Api.api, { baseUrl: server.baseUrl });
    const label = RecordLabel.make("Voucher A17");

    const result = yield* client.comparisons.labels({ payload: { left: label, right: label } });

    expect(result).toBe(true);

    yield* server.child.kill({ killSignal: "SIGINT", forceKillAfter: "5 seconds" });
    const exitCode = yield* server.child.exitCode;
    const stdout = yield* Ref.get(server.stdout);
    const stderr = yield* Ref.get(server.stderr);
    const stopped = yield* HttpClient.get(server.baseUrl).pipe(Effect.result);

    expect(exitCode).toBe(130);
    expect(stdout).toBe("");
    expect(stderr).toContain(server.baseUrl);
    expect(Result.isFailure(stopped)).toBe(true);
  }).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live("fails cleanly when another server already occupies the requested port", () =>
  Effect.gen(function* () {
    const first = yield* startServer();
    const port = new URL(first.baseUrl).port;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(
      execPath,
      ["src/main.ts", "server", "--model", "fixture-model", "--port", port],
      { env: environment, extendEnv: false, stdin: "ignore" },
    );
    const second = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        second.stdout.pipe(Stream.decodeText(), Stream.mkString),
        second.stderr.pipe(Stream.decodeText(), Stream.mkString),
        second.exitCode,
      ],
      { concurrency: "unbounded" },
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Cannot start the HTTP server");
  }).pipe(Effect.provide(NodeServices.layer)),
);
