import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ByteSize, Effect, Layer, Logger, Match, Predicate, Result, Schema } from "effect";
import { DecisionModel } from "effect/ai";
import { CliError, Command, Flag } from "effect/cli";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest } from "effect/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api";
import { TaxonSet, Taxonomy } from "robo-taxonomist";
import * as Api from "./api.ts";
import * as Documents from "./documents.ts";
import * as Model from "./model.ts";

const defaultRequestLimits = { maxBodyBytes: 1_048_576, timeoutMs: 60_000, maxJsonDepth: 64 };

const positiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const Options = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  maxBodyBytes: positiveInteger,
  timeoutMs: positiveInteger,
  maxJsonDepth: positiveInteger,
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const exceedsJsonDepth = (value: unknown, maximum: number): boolean => {
  const pending: Array<Iterator<unknown>> = [[value][Symbol.iterator]()];

  while (pending.length > 0) {
    const level = pending[pending.length - 1];
    if (level === undefined) return false;
    const next = level.next();

    if (next.done) {
      pending.pop();
    } else if (Predicate.isObjectOrArray(next.value)) {
      if (pending.length > maximum) return true;
      const children = Object.values(next.value);
      pending.push(children[Symbol.iterator]());
    }
  }

  return false;
};

export const requestBounds = (limits = defaultRequestLimits) => {
  const maxBodySize = ByteSize.bytes(limits.maxBodyBytes);

  return Layer.succeed(Api.RequestBounds, (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const text = yield* request.text.pipe(
        Effect.mapError((error) =>
          Match.value(error.reason).pipe(
            Match.tag("RequestParseError", (reason) =>
              Match.value(reason.reason).pipe(
                Match.when(undefined, () =>
                  Api.RequestReadFailure.make({ message: "Cannot read the request body" }),
                ),
                Match.literalsExhaustive({
                  BodyTooLarge: () =>
                    Api.RequestTooLarge.make({ maxBodyBytes: limits.maxBodyBytes }),
                  Parse: () =>
                    Api.RequestReadFailure.make({ message: "Cannot read the request body" }),
                }),
              ),
            ),
            Match.orElse(() =>
              Api.RequestReadFailure.make({ message: "Cannot read the request body" }),
            ),
          ),
        ),
      );

      const header = request.headers["content-type"] ?? "application/json";
      const separator = header.indexOf(";");
      const mediaType = separator === -1 ? header : header.slice(0, separator);
      const contentType = mediaType.trim().toLowerCase();

      if (contentType === "application/json" && text !== "") {
        const parsed = yield* decodeJson(text).pipe(Effect.result);

        if (Result.isSuccess(parsed) && exceedsJsonDepth(parsed.success, limits.maxJsonDepth)) {
          return yield* Effect.fail(Api.RequestTooDeep.make({ maxJsonDepth: limits.maxJsonDepth }));
        }
      }

      return yield* httpEffect;
    }).pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBodySize),
      Effect.timeoutOrElse({
        duration: limits.timeoutMs,
        orElse: () => Effect.fail(Api.RequestDeadline.make({ timeoutMs: limits.timeoutMs })),
      }),
    ),
  );
};

const modelFailure = () => Api.ModelFailure.make({ message: "The decision model request failed" });

const setDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.SetDocument));
const relationDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.SetRelationJudgment));
const outputFailure = () =>
  Api.OutputFailure.make({ message: "Cannot encode the operation result" });
const isRecordDocument = Schema.is(Documents.RecordDocument);

const operandSet = Effect.fnUntraced(function* (operand: typeof Api.SetOperand.Type) {
  return yield* Effect.try({
    try: () =>
      Match.value(operand).pipe(
        Match.when(Predicate.isString, (name) => TaxonSet.of(name)),
        Match.when(isRecordDocument, (record) => TaxonSet.of(record)),
        Match.orElse(Documents.restoreSet),
      ),
    catch: () => Api.InvalidSet.make({ message: "The set input is invalid or too deeply nested" }),
  });
});

export const comparisons = HttpApiBuilder.group(
  Api.api,
  "comparisons",
  Effect.fn("Server.comparisons")(function* (handlers) {
    const model = yield* DecisionModel.DecisionModel;

    return handlers
      .handle("labels", ({ payload }) => {
        const sameLabel = Taxonomy.sameLabel(payload.left, payload.right);
        return Effect.succeed(sameLabel);
      })
      .handle("identity", ({ payload }) =>
        Taxonomy.sameTaxon(payload.left, payload.right).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
          Effect.mapError(modelFailure),
        ),
      )
      .handle("containment", ({ payload }) =>
        Taxonomy.taxonWithin(payload.inner, payload.outer).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
          Effect.mapError(modelFailure),
        ),
      )
      .handle("rank", ({ payload, query }) =>
        Taxonomy.sameTaxonAtRank(payload.left, payload.right, query.rank).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
          Effect.mapError(modelFailure),
        ),
      );
  }),
);

export const sets = HttpApiBuilder.group(
  Api.api,
  "sets",
  Effect.fn("Server.sets")(function* (handlers) {
    const model = yield* DecisionModel.DecisionModel;

    return handlers
      .handle("create", ({ payload }) => {
        const taxa = payload.targets.map((target) => {
          const record = Predicate.isString(target) ? { scientificName: target } : target;
          return TaxonSet.of(record);
        });
        const result = TaxonSet.unionAll(taxa);

        return setDocument(result).pipe(Effect.mapError(outputFailure));
      })
      .handle(
        "union",
        Effect.fn("Server.union")(function* ({ payload }) {
          const left = yield* operandSet(payload.left);
          const right = yield* operandSet(payload.right);
          const result = TaxonSet.union(left, right);

          return yield* setDocument(result).pipe(Effect.mapError(outputFailure));
        }),
      )
      .handle(
        "intersection",
        Effect.fn("Server.intersection")(function* ({ payload }) {
          const left = yield* operandSet(payload.left);
          const right = yield* operandSet(payload.right);
          const result = TaxonSet.intersection(left, right);

          return yield* setDocument(result).pipe(Effect.mapError(outputFailure));
        }),
      )
      .handle(
        "difference",
        Effect.fn("Server.difference")(function* ({ payload }) {
          const left = yield* operandSet(payload.left);
          const right = yield* operandSet(payload.right);
          const result = TaxonSet.difference(left, right);

          return yield* setDocument(result).pipe(Effect.mapError(outputFailure));
        }),
      )
      .handle(
        "relation",
        Effect.fn("Server.relation")(function* ({ payload, query }) {
          const left = yield* operandSet(payload.left);
          const right = yield* operandSet(payload.right);
          const operations = {
            subset: TaxonSet.isSubsetOf,
            "proper-subset": TaxonSet.isProperSubsetOf,
            equivalent: TaxonSet.equivalent,
            overlap: TaxonSet.overlaps,
            disjoint: TaxonSet.disjoint,
          };
          const operation = operations[query.relation];
          const result = yield* operation(left, right).pipe(
            Effect.provideService(DecisionModel.DecisionModel, model),
            Effect.mapError(modelFailure),
          );

          return yield* relationDocument(result).pipe(Effect.mapError(outputFailure));
        }),
      );
  }),
);

export const layer = (options: typeof Options.Type) => {
  const bounds = requestBounds(options);
  const handlers = Layer.mergeAll(comparisons, sets).pipe(Layer.provideMerge(bounds));
  const apiRoutes = HttpApiBuilder.layer(Api.api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
  );
  const docs = HttpApiScalar.layer(Api.api, { path: "/docs" });
  const routes = Layer.mergeAll(apiRoutes, docs);
  const platform = NodeHttpServer.layer(NodeHttp.createServer, {
    host: options.host,
    port: options.port,
  });

  return HttpRouter.serve(routes).pipe(Layer.provideMerge(platform));
};

export const command = Command.make(
  "server",
  {
    model: Model.modelFlag,
    host: Flag.String("host").pipe(
      Flag.withSchema(Options.fields.host),
      Flag.withDefault("127.0.0.1"),
    ),
    port: Flag.Int("port").pipe(Flag.withSchema(Options.fields.port), Flag.withDefault(3000)),
    maxBodyBytes: Flag.Int("max-body-bytes").pipe(
      Flag.withSchema(Options.fields.maxBodyBytes),
      Flag.withDefault(defaultRequestLimits.maxBodyBytes),
    ),
    timeoutMs: Flag.Int("request-timeout-ms").pipe(
      Flag.withSchema(Options.fields.timeoutMs),
      Flag.withDefault(defaultRequestLimits.timeoutMs),
    ),
    maxJsonDepth: Flag.Int("max-json-depth").pipe(
      Flag.withSchema(Options.fields.maxJsonDepth),
      Flag.withDefault(defaultRequestLimits.maxJsonDepth),
    ),
  },
  Effect.fn("Cli.server")(
    function* ({ host, port, maxBodyBytes, timeoutMs, maxJsonDepth }) {
      const options = Options.make({ host, port, maxBodyBytes, timeoutMs, maxJsonDepth });
      const server = layer(options);

      return yield* Layer.launch(server).pipe(
        Effect.mapError(
          (cause) =>
            new CliError.UserError({
              cause,
              userMessage: "Cannot start the HTTP server; check the bind address and port",
            }),
        ),
      );
    },
    Effect.provideService(Logger.LogToStderr, true),
  ),
).pipe(
  Command.withDescription(
    "Serve taxonomy comparisons and symbolic set operations in the foreground. The default address is 127.0.0.1:3000; --port 0 selects an available port. Readiness and request diagnostics go to stderr. Interrupt the process to stop the server and release its socket.\n\n" +
      "The request-body limit defaults to 1048576 bytes (1 MiB), enforced while reading before JSON decoding. The whole request has a 60000 ms deadline, including body reading and model execution; expiry interrupts ongoing work. Override these startup policies with --max-body-bytes and --request-timeout-ms. They do not limit ordinary CLI inputs.\n\n" +
      "JSON requests allow 64 nested object/array containers by default, including the root and metadata. Override with --max-json-depth; exceeding the limit returns RequestTooDeep (400) before endpoint validation. Large flat arrays do not increase nesting depth. Raising this limit can exceed the recursive endpoint decoder's stack capacity.\n\n" +
      "Open /docs for interactive Scalar documentation and /openapi.json for the generated contract. Import the application API definition with HttpApiClient to derive a typed client.\n\n" +
      "Use --model to override ROBO_TAXONOMIST_MODEL and inject TYPESAFE_API_KEY through the environment. One client/model is acquired at startup for all requests. Credentials and model configuration are not request parameters. Help needs no credentials.\n\n" +
      "This local service has no built-in authentication. Keep the loopback default unless appropriate external access controls are in place.",
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist server --model your-model --port 3000",
      description: "Run the local API and documentation until interrupted.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);
