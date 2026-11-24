import { MIMEType } from "node:util";
import { ByteSize, Effect, Layer, Match, Predicate, Result, Schema } from "effect";
import { HttpIncomingMessage, HttpServerError, HttpServerRequest } from "effect/http";
import * as Api from "./api.ts";

/** Default byte, time and JSON-depth limits for requests. */
export const defaultRequestLimits = {
  maxBodyBytes: 1_048_576,
  timeoutMs: 60_000,
  maxJsonDepth: 64,
};

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

const requestReadFailure = (error: HttpServerError.HttpServerError, maxBodyBytes: number) => {
  const bodyTooLarge = Match.value(error.reason).pipe(
    Match.tag("RequestParseError", ({ reason }) => reason === "BodyTooLarge"),
    Match.orElse(() => false),
  );

  return bodyTooLarge
    ? new Api.RequestTooLarge({ maxBodyBytes })
    : new Api.RequestReadFailure({ message: "Cannot read the request body" });
};

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

/** Limit body size and JSON depth. The deadline covers body reads and endpoint execution. */
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
