import { Cause, Context, Effect, Redacted } from "effect";

/** Internal failure context; not a field of the mapped error or its wire codec. */
export class FailureDiagnostic extends Context.Service<
  FailureDiagnostic,
  Redacted.Redacted<Cause.Cause<unknown>>
>()("demo/FailureDiagnostic") {}

/** Map failures to a safe value without exposing or discarding their original cause. */
export const retainCauseAs = <E>(failure: () => E) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.failCause(
      Cause.annotate(
        Cause.map(cause, failure),
        Context.make(FailureDiagnostic, Redacted.make(cause)),
      ),
    ),
  );
