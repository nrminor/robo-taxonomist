import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { RecordLabel, TaxonName } from "robo-taxonomist";
import * as Documents from "./documents.ts";

/** Report invalid taxonomic input without exposing its validation cause. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
  { description: "The supplied taxonomic input is invalid.", httpApiStatus: 400 },
) {}

/** Report a model request failure without exposing provider details. */
export class ModelFailure extends Schema.TaggedError<ModelFailure>()(
  "ModelFailure",
  {
    message: Schema.String,
  },
  {
    description: "The decision model request failed.",
    httpApiStatus: 502,
  },
) {}

/** Report a result that cannot be encoded for HTTP. */
export class OutputFailure extends Schema.TaggedError<OutputFailure>()(
  "OutputFailure",
  {
    message: Schema.String,
  },
  {
    description: "The operation result could not be encoded.",
    httpApiStatus: 500,
  },
) {}

/** Report a set document that cannot be restored. */
export class InvalidSet extends Schema.TaggedError<InvalidSet>()(
  "InvalidSet",
  {
    message: Schema.String,
  },
  {
    description: "The supplied set could not be restored.",
    httpApiStatus: 400,
  },
) {}

/** Report the configured byte limit when a request body exceeds it. */
export class RequestTooLarge extends Schema.TaggedError<RequestTooLarge>()(
  "RequestTooLarge",
  {
    maxBodyBytes: Schema.Int,
  },
  {
    description: "The request body exceeds the configured byte limit.",
    httpApiStatus: 413,
  },
) {}

/** Report a request body that cannot be read. */
export class RequestReadFailure extends Schema.TaggedError<RequestReadFailure>()(
  "RequestReadFailure",
  {
    message: Schema.String,
  },
  {
    description: "The request body could not be read.",
    httpApiStatus: 400,
  },
) {}

/** Report the configured depth limit when JSON nesting exceeds it. */
export class RequestTooDeep extends Schema.TaggedError<RequestTooDeep>()(
  "RequestTooDeep",
  {
    maxJsonDepth: Schema.Int,
  },
  {
    description: "The JSON body exceeds the configured nesting depth.",
    httpApiStatus: 400,
  },
) {}

/** Report which record, target or pair count exceeds its configured limit. */
export class CollectionLimit extends Schema.TaggedError<CollectionLimit>()(
  "CollectionLimit",
  {
    resource: Schema.Literals(["records", "targets", "recordTargetPairs"]),
    maximum: Schema.Int,
    actual: Schema.Int,
  },
  {
    description: "The request exceeds a configured record, target or record-target pair limit.",
    httpApiStatus: 413,
  },
) {}

/** Report the configured time limit when a request exceeds it. */
export class RequestDeadline extends Schema.TaggedError<RequestDeadline>()(
  "RequestDeadline",
  {
    timeoutMs: Schema.Int,
  },
  {
    description: "The request exceeded its time limit.",
    httpApiStatus: 504,
  },
) {}

/** Require the server's request-limit middleware on every API endpoint. */
export class RequestBounds extends HttpApiMiddleware.Service<RequestBounds>()(
  "robo-taxonomist/http/RequestBounds",
  { error: [RequestTooLarge, RequestTooDeep, RequestReadFailure, RequestDeadline] },
) {}

const assignment = Schema.Union([TaxonName, Documents.RecordDocument]);
const record = Schema.Union([RecordLabel, Documents.RecordDocument]);
/** Accept a target name, identifying record or saved set as an operand. */
export const SetOperand = Schema.Union([
  TaxonName,
  Documents.RecordDocument,
  Documents.SetDocument,
]).annotate({
  identifier: "SetOperand",
  description: "A target name, identifying record or saved set definition.",
});
const setPair = Schema.Struct({ left: SetOperand, right: SetOperand });
/** Supply ordered records and one target set for a membership request. */
export const CollectionInput = Schema.Struct({
  records: Schema.Array(Documents.RecordInput),
  target: SetOperand,
}).annotate({
  identifier: "CollectionInput",
  description:
    "Records to check against a target set. Record order and repeated occurrences are retained.",
});

const comparisons = HttpApiGroup.make("comparisons").add(
  HttpApiEndpoint.post("labels", "/compare/labels", {
    payload: Schema.Struct({ left: RecordLabel, right: RecordLabel }),
    success: Schema.Boolean,
  }),
  HttpApiEndpoint.post("identity", "/compare/identity", {
    payload: Schema.Struct({ left: assignment, right: assignment }),
    success: Documents.IdentityJudgment,
    error: [InvalidInput, ModelFailure],
  }),
  HttpApiEndpoint.post("containment", "/compare/containment", {
    payload: Schema.Struct({ inner: assignment, outer: assignment }),
    success: Documents.ContainmentJudgment,
    error: [InvalidInput, ModelFailure],
  }),
  HttpApiEndpoint.post("rank", "/compare/rank", {
    payload: Schema.Struct({ left: record, right: record }),
    query: { rank: Documents.TaxonomicRank },
    success: Documents.RankJudgment,
    error: [InvalidInput, ModelFailure],
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
    error: [InvalidSet, InvalidInput, ModelFailure, OutputFailure],
  }),
);

const membership = HttpApiGroup.make("membership").add(
  HttpApiEndpoint.post("check", "/membership/check", {
    payload: Schema.Struct({ record: Documents.RecordInput, target: SetOperand }),
    success: Documents.MembershipJudgment,
    error: [InvalidSet, InvalidInput, ModelFailure, OutputFailure, CollectionLimit],
  }),
  HttpApiEndpoint.post("partition", "/membership/partition", {
    payload: CollectionInput,
    success: Documents.MembershipPartition,
    error: [InvalidSet, InvalidInput, ModelFailure, OutputFailure, CollectionLimit],
  }),
  HttpApiEndpoint.post("all", "/membership/all", {
    payload: CollectionInput,
    success: Documents.QuantifierJudgment,
    error: [InvalidSet, InvalidInput, ModelFailure, OutputFailure, CollectionLimit],
  }),
  HttpApiEndpoint.post("any", "/membership/any", {
    payload: CollectionInput,
    success: Documents.QuantifierJudgment,
    error: [InvalidSet, InvalidInput, ModelFailure, OutputFailure, CollectionLimit],
  }),
  HttpApiEndpoint.post("none", "/membership/none", {
    payload: CollectionInput,
    success: Documents.QuantifierJudgment,
    error: [InvalidSet, InvalidInput, ModelFailure, OutputFailure, CollectionLimit],
  }),
);

const classification = HttpApiGroup.make("classification").add(
  HttpApiEndpoint.post("classify", "/classify", {
    payload: Schema.Struct({ records: Schema.Array(Documents.RecordInput), panel: SetOperand }),
    success: Documents.Classification,
    error: [InvalidSet, InvalidInput, ModelFailure, OutputFailure, CollectionLimit],
  }),
);

/** Describe the taxonomy endpoints, result schemas and typed HTTP failures. */
export const api = HttpApi.make("robo-taxonomist")
  .add(comparisons, sets, membership, classification)
  .middleware(RequestBounds);
