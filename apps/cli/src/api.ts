import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/http-api";
import { RecordLabel, TaxonName } from "robo-taxonomist";
import * as Documents from "./documents.ts";

export const ModelFailure = Schema.TaggedStruct("ModelFailure", {
  message: Schema.String,
}).pipe(HttpApiSchema.status(502));

export const OutputFailure = Schema.TaggedStruct("OutputFailure", {
  message: Schema.String,
}).pipe(HttpApiSchema.status(500));

export const InvalidSet = Schema.TaggedStruct("InvalidSet", {
  message: Schema.String,
}).pipe(HttpApiSchema.status(400));

export const RequestTooLarge = Schema.TaggedStruct("RequestTooLarge", {
  maxBodyBytes: Schema.Int,
}).pipe(HttpApiSchema.status(413));

export const RequestReadFailure = Schema.TaggedStruct("RequestReadFailure", {
  message: Schema.String,
}).pipe(HttpApiSchema.status(400));

export const RequestTooDeep = Schema.TaggedStruct("RequestTooDeep", {
  maxJsonDepth: Schema.Int,
}).pipe(HttpApiSchema.status(400));

export const RequestDeadline = Schema.TaggedStruct("RequestDeadline", {
  timeoutMs: Schema.Int,
}).pipe(HttpApiSchema.status(504));

export class RequestBounds extends HttpApiMiddleware.Service<RequestBounds>()(
  "robo-taxonomist/http/RequestBounds",
  { error: [RequestTooLarge, RequestTooDeep, RequestReadFailure, RequestDeadline] },
) {}

const assignment = Schema.Union([TaxonName, Documents.RecordDocument]);
const record = Schema.Union([RecordLabel, Documents.RecordDocument]);
export const SetOperand = Schema.Union([
  TaxonName,
  Documents.RecordDocument,
  Documents.SetDocument,
]);
const setPair = Schema.Struct({ left: SetOperand, right: SetOperand });

const comparisons = HttpApiGroup.make("comparisons").add(
  HttpApiEndpoint.post("labels", "/compare/labels", {
    payload: Schema.Struct({ left: RecordLabel, right: RecordLabel }),
    success: Schema.Boolean,
  }),
  HttpApiEndpoint.post("identity", "/compare/identity", {
    payload: Schema.Struct({ left: assignment, right: assignment }),
    success: Documents.IdentityJudgment,
    error: ModelFailure,
  }),
  HttpApiEndpoint.post("containment", "/compare/containment", {
    payload: Schema.Struct({ inner: assignment, outer: assignment }),
    success: Documents.ContainmentJudgment,
    error: ModelFailure,
  }),
  HttpApiEndpoint.post("rank", "/compare/rank", {
    payload: Schema.Struct({ left: record, right: record }),
    query: { rank: Documents.TaxonomicRank },
    success: Documents.RankJudgment,
    error: ModelFailure,
  }),
);

const sets = HttpApiGroup.make("sets").add(
  HttpApiEndpoint.post("create", "/sets/create", {
    payload: Schema.Struct({ targets: Schema.Array(assignment) }),
    success: Documents.SetDocument,
    error: OutputFailure,
  }),
  HttpApiEndpoint.post("union", "/sets/union", {
    payload: setPair,
    success: Documents.SetDocument,
    error: [InvalidSet, OutputFailure],
  }),
  HttpApiEndpoint.post("intersection", "/sets/intersection", {
    payload: setPair,
    success: Documents.SetDocument,
    error: [InvalidSet, OutputFailure],
  }),
  HttpApiEndpoint.post("difference", "/sets/difference", {
    payload: setPair,
    success: Documents.SetDocument,
    error: [InvalidSet, OutputFailure],
  }),
  HttpApiEndpoint.post("relation", "/sets/relation", {
    payload: setPair,
    query: { relation: Documents.SetRelation },
    success: Documents.SetRelationJudgment,
    error: [InvalidSet, ModelFailure, OutputFailure],
  }),
);

export const api = HttpApi.make("robo-taxonomist").add(comparisons, sets).middleware(RequestBounds);
