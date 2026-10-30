import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { initialPanelId, PanelId } from "../lib/catalog.ts";
import {
  ClassificationFailure,
  classificationFailureFields,
  ClassifyRequest,
  PanelResponse,
} from "../lib/contract.ts";

/** Server failures plus local transport/decoding failures, whose causes are not server response fields. */
export const RequestFailure = Schema.TaggedUnion({
  ...classificationFailureFields,
  TransportFailure: { cause: Schema.Defect() },
  ResponseDecodingFailure: { cause: Schema.Defect() },
});
export type RequestFailure = typeof RequestFailure.Type;

const transportFailure = (cause: unknown) => RequestFailure.cases.TransportFailure.make({ cause });
const responseDecodingFailure = (cause: unknown) =>
  RequestFailure.cases.ResponseDecodingFailure.make({ cause });

const encodeRequest = (panelId: PanelId) =>
  HttpClientRequest.schemaBodyJson(ClassifyRequest)(HttpClientRequest.post("/api/classify"), {
    panelId,
  }).pipe(Effect.mapError(() => RequestFailure.cases.InternalFailure.make({})));

const readSuccess = (response: HttpClientResponse.HttpClientResponse, panelId: PanelId) =>
  HttpClientResponse.schemaBodyJson(PanelResponse)(response).pipe(
    Effect.mapError(responseDecodingFailure),
    Effect.filterOrFail(
      (reply) => reply.panelId === panelId,
      (reply) => responseDecodingFailure({ expectedPanel: panelId, receivedPanel: reply.panelId }),
    ),
  );

const readFailure = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(ClassificationFailure)(response).pipe(
    Effect.mapError(responseDecodingFailure),
    Effect.flatMap(Effect.fail),
  );

const postClassification = Effect.fn("postClassification")(function* (panelId: PanelId) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* encodeRequest(panelId);
  const response = yield* client.execute(request).pipe(Effect.mapError(transportFailure));
  return yield* HttpClientResponse.matchStatus(response, {
    "2xx": (response) => readSuccess(response, panelId),
    orElse: readFailure,
  });
});

/** Shared atom runtime supplying browser Fetch for classification requests. */
export const browserRuntime = Atom.runtime(FetchHttpClient.layer);
/** Initial panel request with a server-renderable initial state and no idle retention. */
export const initialQueryAtom = browserRuntime
  .atom(postClassification(initialPanelId))
  .pipe(Atom.setIdleTTL(0), Atom.withServerValueInitial);
/** Run a selected-panel request, validating response structure and that its panel ID matches the request. */
export const selectPanelAtom = browserRuntime.fn(postClassification);

/** Optional inspected record and interaction origin, allowing views to distinguish list and example choices. */
export const recordSelectionAtom = Atom.make<
  Option.Option<{ readonly recordId: string; readonly origin: "record" | "example" }>
>(Option.none());
