import * as NodeHttp from "node:http";
import { MIMEType } from "node:util";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ByteSize, Effect, Layer, Logger, Match, Predicate, Result, Schema } from "effect";
import { DecisionModel } from "effect/ai";
import { CliError, Command, Flag } from "effect/cli";
import { HttpIncomingMessage, HttpRouter, HttpServerError, HttpServerRequest } from "effect/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api";
import { CollectionExecution, TaxonSet, Taxonomy, type Errors } from "robo-taxonomist";
import * as Api from "./api.ts";
import * as Documents from "./documents.ts";
import * as Model from "./model.ts";

const defaultRequestLimits = { maxBodyBytes: 1_048_576, timeoutMs: 60_000, maxJsonDepth: 64 };
const defaultCollectionLimits = {
  maxRecords: 1000,
  maxTargets: 100,
  maxRecordTargetPairs: 10_000,
  batchSize: 16,
  concurrency: 1,
};

const positiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
/** Validate the server's bind address, request limits and collection execution settings. */
export const Options = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  maxBodyBytes: positiveInteger,
  timeoutMs: positiveInteger,
  maxJsonDepth: positiveInteger,
  maxRecords: positiveInteger,
  maxTargets: positiveInteger,
  maxRecordTargetPairs: positiveInteger,
  batchSize: CollectionExecution.schema.fields.batchSize,
  concurrency: CollectionExecution.schema.fields.concurrency,
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

const requestReadFailure = (error: HttpServerError.HttpServerError, maxBodyBytes: number) =>
  Match.value(error.reason).pipe(
    Match.when(
      { _tag: "RequestParseError", reason: "BodyTooLarge" },
      () => new Api.RequestTooLarge({ maxBodyBytes }),
    ),
    Match.orElse(() => new Api.RequestReadFailure({ message: "Cannot read the request body" })),
  );

/** Check depth before endpoint validation; let the API handle syntax and content-type errors. */
const checkJsonDepth = Effect.fnUntraced(function* (
  text: string,
  header: string | undefined,
  maximum: number,
) {
  if (text === "") return;

  const contentType = header ?? "application/json";
  const mediaType = Result.try(() => new MIMEType(contentType.trim()));
  if (Result.isFailure(mediaType) || mediaType.success.essence !== "application/json") return;

  const parsed = yield* decodeJson(text).pipe(Effect.result);
  if (Result.isSuccess(parsed) && exceedsJsonDepth(parsed.success, maximum)) {
    return yield* new Api.RequestTooDeep({ maxJsonDepth: maximum });
  }
});

/** Enforce byte, JSON-depth and time limits around endpoint decoding and execution. */
export const requestBounds = (limits = defaultRequestLimits) => {
  const maxBodySize = ByteSize.bytes(limits.maxBodyBytes);

  return Layer.succeed(Api.RequestBounds, (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const text = yield* request.text.pipe(
        Effect.mapError((error) => requestReadFailure(error, limits.maxBodyBytes)),
      );
      yield* checkJsonDepth(text, request.headers["content-type"], limits.maxJsonDepth);

      return yield* httpEffect;
    }).pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBodySize),
      Effect.timeoutOrElse({
        duration: limits.timeoutMs,
        orElse: () => new Api.RequestDeadline({ timeoutMs: limits.timeoutMs }),
      }),
    ),
  );
};

const taxonomyFailure = (error: Errors.TaxonomyError) =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      InvalidInput: () =>
        new Api.InvalidInput({ message: "The supplied taxonomic input is invalid" }),
      AiError: () => new Api.ModelFailure({ message: "The decision model request failed" }),
    }),
  );

const setDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.SetDocument));
const relationDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.SetRelationJudgment));
const membershipDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.MembershipJudgment));
const partitionDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.MembershipPartition));
const quantifierDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.QuantifierJudgment));
const classificationDocument = Schema.decodeUnknownEffect(Schema.toType(Documents.Classification));
const outputFailure = () =>
  new Api.OutputFailure({ message: "Cannot encode the operation result" });
const isRecordDocument = Schema.is(Documents.RecordDocument);

const targetCount = (operand: typeof Api.SetOperand.Type): number => {
  if (Predicate.isString(operand) || isRecordDocument(operand)) return 1;

  return Documents.SetDocument.match(operand, {
    Empty: () => 0,
    Taxon: () => 1,
    Union: ({ operands }) => operands.reduce((count, child) => count + targetCount(child), 0),
    Intersection: ({ operands }) =>
      operands.reduce((count, child) => count + targetCount(child), 0),
    Difference: ({ left, right }) => targetCount(left) + targetCount(right),
  });
};

const checkCollection = Effect.fnUntraced(function* (
  records: number,
  target: typeof Api.SetOperand.Type,
  limits: typeof defaultCollectionLimits,
) {
  if (records > limits.maxRecords) {
    return yield* new Api.CollectionLimit({
      resource: "records",
      maximum: limits.maxRecords,
      actual: records,
    });
  }
  const targets = targetCount(target);
  if (targets > limits.maxTargets) {
    return yield* new Api.CollectionLimit({
      resource: "targets",
      maximum: limits.maxTargets,
      actual: targets,
    });
  }
  const pairs = records * targets;
  if (pairs > limits.maxRecordTargetPairs) {
    return yield* new Api.CollectionLimit({
      resource: "recordTargetPairs",
      maximum: limits.maxRecordTargetPairs,
      actual: pairs,
    });
  }
});

const operandSet = Effect.fnUntraced(function* (operand: typeof Api.SetOperand.Type) {
  return yield* Effect.try({
    try: () =>
      Match.value(operand).pipe(
        Match.when(Predicate.isString, (name) => TaxonSet.of(name)),
        Match.when(isRecordDocument, (record) => TaxonSet.of(record)),
        Match.orElse(Documents.restoreSet),
      ),
    catch: () => new Api.InvalidSet({ message: "The set input is invalid or too deeply nested" }),
  });
});

/** Bind comparison endpoints to the model acquired by this layer. */
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
          Effect.mapError(taxonomyFailure),
        ),
      )
      .handle("containment", ({ payload }) =>
        Taxonomy.taxonWithin(payload.inner, payload.outer).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
          Effect.mapError(taxonomyFailure),
        ),
      )
      .handle("rank", ({ payload, query }) =>
        Taxonomy.sameTaxonAtRank(payload.left, payload.right, query.rank).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
          Effect.mapError(taxonomyFailure),
        ),
      );
  }),
);

/** Bind set construction and relation endpoints to the configured model. */
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
          const operation = Match.value(query.relation).pipe(
            Match.literalsExhaustive({
              subset: () => TaxonSet.isSubsetOf(left, right),
              "proper-subset": () => TaxonSet.isProperSubsetOf(left, right),
              equivalent: () => TaxonSet.equivalent(left, right),
              overlap: () => TaxonSet.overlaps(left, right),
              disjoint: () => TaxonSet.disjoint(left, right),
            }),
          );
          const result = yield* operation.pipe(
            Effect.provideService(DecisionModel.DecisionModel, model),
            Effect.mapError(taxonomyFailure),
          );

          return yield* relationDocument(result).pipe(Effect.mapError(outputFailure));
        }),
      );
  }),
);

/** Configure membership handlers with fixed record, target and batch limits. */
export const membership = (limits = defaultCollectionLimits) =>
  HttpApiBuilder.group(
    Api.api,
    "membership",
    Effect.fn("Server.membership")(function* (handlers) {
      const model = yield* DecisionModel.DecisionModel;
      const execution = CollectionExecution.make({
        batchSize: limits.batchSize,
        concurrency: limits.concurrency,
      });

      const quantify = Effect.fn("Server.quantifyMembership")(function* (
        operation: typeof Taxonomy.allRecordsBelongTo,
        payload: typeof Api.CollectionInput.Type,
      ) {
        yield* checkCollection(payload.records.length, payload.target, limits);
        const target = yield* operandSet(payload.target);
        const result = yield* operation(payload.records, target, { execution }).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
          Effect.mapError(taxonomyFailure),
        );

        return yield* quantifierDocument(result).pipe(Effect.mapError(outputFailure));
      });

      return handlers
        .handle(
          "check",
          Effect.fn("Server.checkMembership")(function* ({ payload }) {
            yield* checkCollection(1, payload.target, limits);
            const target = yield* operandSet(payload.target);
            const result = yield* Taxonomy.recordBelongsTo(payload.record, target).pipe(
              Effect.provideService(DecisionModel.DecisionModel, model),
              Effect.mapError(taxonomyFailure),
            );

            return yield* membershipDocument(result).pipe(Effect.mapError(outputFailure));
          }),
        )
        .handle(
          "partition",
          Effect.fn("Server.partitionMembership")(function* ({ payload }) {
            yield* checkCollection(payload.records.length, payload.target, limits);
            const target = yield* operandSet(payload.target);
            const result = yield* Taxonomy.partitionRecordsByMembership(payload.records, target, {
              execution,
            }).pipe(
              Effect.provideService(DecisionModel.DecisionModel, model),
              Effect.mapError(taxonomyFailure),
            );

            return yield* partitionDocument(result).pipe(Effect.mapError(outputFailure));
          }),
        )
        .handle("all", ({ payload }) => quantify(Taxonomy.allRecordsBelongTo, payload))
        .handle("any", ({ payload }) => quantify(Taxonomy.anyRecordBelongsTo, payload))
        .handle("none", ({ payload }) => quantify(Taxonomy.noRecordBelongsTo, payload));
    }),
  );

/** Configure classification handlers with fixed panel, record and batch limits. */
export const classification = (limits = defaultCollectionLimits) =>
  HttpApiBuilder.group(
    Api.api,
    "classification",
    Effect.fn("Server.classification")(function* (handlers) {
      const model = yield* DecisionModel.DecisionModel;
      const execution = CollectionExecution.make({
        batchSize: limits.batchSize,
        concurrency: limits.concurrency,
      });

      return handlers.handle(
        "classify",
        Effect.fn("Server.classify")(function* ({ payload }) {
          yield* checkCollection(payload.records.length, payload.panel, limits);
          const panel = yield* operandSet(payload.panel);
          const result = yield* Taxonomy.classifyRecords(payload.records, panel, {
            execution,
          }).pipe(
            Effect.provideService(DecisionModel.DecisionModel, model),
            Effect.mapError(taxonomyFailure),
          );

          return yield* classificationDocument(result).pipe(Effect.mapError(outputFailure));
        }),
      );
    }),
  );

/** Serve the API and documentation with a scoped Node HTTP server. */
export const layer = (options: typeof Options.Type) => {
  const bounds = requestBounds(options);
  const handlers = Layer.mergeAll(
    comparisons,
    sets,
    membership(options),
    classification(options),
  ).pipe(Layer.provideMerge(bounds));
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

/** Run the API in the foreground with the model and limits selected at startup. */
export const command = Command.make(
  "server",
  {
    model: Model.modelFlag,
    host: Flag.String("host").pipe(
      Flag.withSchema(Options.fields.host),
      Flag.withDefault("127.0.0.1"),
      Flag.withDescription("Address on which to accept connections (default: 127.0.0.1)."),
    ),
    port: Flag.Int("port").pipe(
      Flag.withSchema(Options.fields.port),
      Flag.withDefault(3000),
      Flag.withDescription("Listening port (default: 3000). Use 0 to select an available port."),
    ),
    maxBodyBytes: Flag.Int("max-body-bytes").pipe(
      Flag.withSchema(Options.fields.maxBodyBytes),
      Flag.withDefault(defaultRequestLimits.maxBodyBytes),
      Flag.withDescription(
        `Maximum request body size in bytes (default: ${defaultRequestLimits.maxBodyBytes}).`,
      ),
    ),
    timeoutMs: Flag.Int("request-timeout-ms").pipe(
      Flag.withSchema(Options.fields.timeoutMs),
      Flag.withDefault(defaultRequestLimits.timeoutMs),
      Flag.withDescription(
        `Time limit in milliseconds to read and process a request (default: ${defaultRequestLimits.timeoutMs}).`,
      ),
    ),
    maxJsonDepth: Flag.Int("max-json-depth").pipe(
      Flag.withSchema(Options.fields.maxJsonDepth),
      Flag.withDefault(defaultRequestLimits.maxJsonDepth),
      Flag.withDescription(
        `Maximum JSON nesting depth, including metadata (default: ${defaultRequestLimits.maxJsonDepth}).`,
      ),
    ),
    maxRecords: Flag.Int("max-records").pipe(
      Flag.withSchema(Options.fields.maxRecords),
      Flag.withDefault(defaultCollectionLimits.maxRecords),
      Flag.withDescription(
        `Maximum records per membership or classification request (default: ${defaultCollectionLimits.maxRecords}).`,
      ),
    ),
    maxTargets: Flag.Int("max-targets").pipe(
      Flag.withSchema(Options.fields.maxTargets),
      Flag.withDefault(defaultCollectionLimits.maxTargets),
      Flag.withDescription(
        `Maximum target taxa per membership or classification request (default: ${defaultCollectionLimits.maxTargets}). Repeats count separately.`,
      ),
    ),
    maxRecordTargetPairs: Flag.Int("max-record-target-pairs").pipe(
      Flag.withSchema(Options.fields.maxRecordTargetPairs),
      Flag.withDefault(defaultCollectionLimits.maxRecordTargetPairs),
      Flag.withDescription(
        `Maximum records × target taxa per membership or classification request (default: ${defaultCollectionLimits.maxRecordTargetPairs}).`,
      ),
    ),
    batchSize: Flag.Int("batch-size").pipe(
      Flag.withSchema(Options.fields.batchSize),
      Flag.withDefault(defaultCollectionLimits.batchSize),
      Flag.withDescription(
        `Records per model request (default: ${defaultCollectionLimits.batchSize}).`,
      ),
    ),
    concurrency: Flag.Int("concurrency").pipe(
      Flag.withSchema(Options.fields.concurrency),
      Flag.withDefault(defaultCollectionLimits.concurrency),
      Flag.withDescription(
        `Model requests to run at once (default: ${defaultCollectionLimits.concurrency}).`,
      ),
    ),
  },
  Effect.fn("Cli.server")(
    function* ({ model: _model, ...settings }) {
      const options = Options.make(settings);
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
  Command.withShortDescription("Start the local HTTP API."),
  Command.withDescription(
    "Start the HTTP API in the foreground. Open /docs for interactive documentation or /openapi.json for the API definition. Press Ctrl-C to stop.\n\n" +
      "The server has no authentication. Keep the default local address unless you provide external access controls.",
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist server",
      description: "Start the API at http://127.0.0.1:3000.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);
