import { Effect, Option, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { initialPanelId, PanelId } from "../lib/catalog.ts";
import {
  ClassificationFailure,
  ClassificationReply,
  ClassifyRequest,
  PanelResponse,
} from "../lib/contract.ts";
import type { Display } from "../lib/display.ts";

export const Selection = Schema.TaggedUnion({ Initial: {}, Panel: { panelId: PanelId } });
export const selectionAtom = Atom.make<typeof Selection.Type>(Selection.cases.Initial.make({}));
export const animatePanelsAtom = Atom.make(false);
export const selectedPanelId = Selection.match({
  Initial: (): PanelId => initialPanelId,
  Panel: ({ panelId }): PanelId => panelId,
});

const ClientFailure = Schema.TaggedUnion({
  TransportFailure: { cause: Schema.Defect() },
  ResponseDecodingFailure: { cause: Schema.Defect() },
});
export const RequestFailure = Schema.Union([
  ClassificationFailure.cases.ModelFailure,
  ClassificationFailure.cases.InvalidPanel,
  ClassificationFailure.cases.ConfigurationFailure,
  ClassificationFailure.cases.InternalFailure,
  ClientFailure.cases.TransportFailure,
  ClientFailure.cases.ResponseDecodingFailure,
]).pipe(Schema.toTaggedUnion("_tag"));
export type RequestFailure = typeof RequestFailure.Type;

export const decodeReply = (wire: Schema.Json): Result.Result<PanelResponse, RequestFailure> =>
  Result.match(Schema.decodeResult(ClassificationReply)(wire), {
    onFailure: (cause) => Result.fail(ClientFailure.cases.ResponseDecodingFailure.make({ cause })),
    onSuccess: (reply) => reply,
  });

const postClassification = Effect.fn("postClassification")(function* (panelId: PanelId) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.schemaBodyJson(ClassifyRequest)(
    HttpClientRequest.post("/api/classify"),
    { panelId },
  ).pipe(Effect.orDie);
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((cause) => ClientFailure.cases.TransportFailure.make({ cause })));
  const wire = yield* response.json.pipe(
    Effect.mapError((cause) => ClientFailure.cases.ResponseDecodingFailure.make({ cause })),
  );
  const result = yield* Effect.fromResult(decodeReply(wire));
  if (response.status < 200 || response.status >= 300 || result.panelId !== panelId) {
    return yield* Effect.fail(
      ClientFailure.cases.ResponseDecodingFailure.make({
        cause: { status: response.status, expectedPanel: panelId, receivedPanel: result.panelId },
      }),
    );
  }
  return result;
});

export const browserRuntime = Atom.runtime(FetchHttpClient.layer);
export const selectPanelAtom = browserRuntime.fn(postClassification);
export const displayedAtom = Atom.make<Option.Option<Display>>(Option.none());

export const recordSelectionAtom = Atom.make<
  Option.Option<{ readonly recordId: string; readonly origin: "record" | "example" }>
>(Option.none());
