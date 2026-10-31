"use client";

import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit, Option, Schema } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useCallback, useEffect, useReducer } from "react";
import { initialPanelId } from "../lib/catalog.ts";
import { ClassificationFailure, ClassifyRequest, PanelResponse } from "../lib/contract.ts";
import { type Display, replaceDisplayed } from "../lib/display.ts";
import { RequestFailure, selectPanelAtom } from "./panel-atoms.ts";

const ReplyReference = Schema.declare<PanelResponse>(Schema.is(PanelResponse));

const Intent = Schema.TaggedUnion({
  Initial: { token: Schema.Symbol },
  Panel: { token: Schema.Symbol, request: ClassifyRequest, animate: Schema.Boolean },
  Retry: {
    token: Schema.Symbol,
    request: ClassifyRequest,
    animate: Schema.Boolean,
    error: RequestFailure,
  },
});
const Phase = Schema.TaggedUnion({
  AwaitingInitial: {},
  Settled: {},
  WaitingSilently: { feedbackAt: Schema.Finite },
  AwaitingFeedbackCommit: {},
  ReadyAwaitingFeedbackCommit: { reply: ReplyReference },
  WaitingVisibly: { notBefore: Schema.Finite },
  HoldingReply: { reply: ReplyReference, notBefore: Schema.Finite },
  ReadyToPublish: { reply: ReplyReference },
  Failed: { error: RequestFailure },
});
const Event = Schema.TaggedUnion({
  Start: { intent: Schema.Union([Intent.cases.Panel, Intent.cases.Retry]), now: Schema.Finite },
  Completed: {
    token: Schema.Symbol,
    exit: Schema.Exit(ReplyReference, RequestFailure, Schema.Defect()),
  },
  Wake: { token: Schema.Symbol, now: Schema.Finite },
  FeedbackCommitted: { token: Schema.Symbol, now: Schema.Finite },
  DisplayCommitted: { token: Schema.Symbol, reply: ReplyReference, animate: Schema.Boolean },
});

/** Eligible results to render; only an actual React commit advances comparison history. */
export interface PublicationCandidate {
  readonly token: symbol;
  readonly display: Display;
  readonly animate: boolean;
}
interface Publication {
  readonly intent: typeof Intent.Type;
  readonly phase: typeof Phase.Type;
  readonly committed: Option.Option<PublicationCandidate>;
}

const initialPublication = (): Publication => ({
  intent: Intent.cases.Initial.make({ token: Symbol() }),
  phase: Phase.cases.AwaitingInitial.make({}),
  committed: Option.none(),
});

const replacementPhase = (phase: typeof Phase.Type, now: number): typeof Phase.Type =>
  Phase.match(phase, {
    AwaitingInitial: (): typeof Phase.Type =>
      Phase.cases.WaitingSilently.make({ feedbackAt: now + 150 }),
    Settled: () => Phase.cases.WaitingSilently.make({ feedbackAt: now + 150 }),
    Failed: () => Phase.cases.WaitingSilently.make({ feedbackAt: now + 150 }),
    ReadyToPublish: () => Phase.cases.WaitingSilently.make({ feedbackAt: now + 150 }),
    WaitingSilently: (waiting) => waiting,
    AwaitingFeedbackCommit: (waiting) => waiting,
    ReadyAwaitingFeedbackCommit: () => Phase.cases.AwaitingFeedbackCommit.make({}),
    WaitingVisibly: (waiting) => waiting,
    HoldingReply: ({ notBefore }) => Phase.cases.WaitingVisibly.make({ notBefore }),
  });

const successPhase = (state: Publication, reply: PanelResponse): typeof Phase.Type =>
  Phase.match(state.phase, {
    AwaitingInitial: () => Phase.cases.ReadyToPublish.make({ reply }),
    Settled: () => state.phase,
    Failed: () => state.phase,
    ReadyToPublish: () => state.phase,
    WaitingSilently: () => Phase.cases.ReadyToPublish.make({ reply }),
    AwaitingFeedbackCommit: () =>
      Intent.guards.Retry(state.intent)
        ? Phase.cases.ReadyAwaitingFeedbackCommit.make({ reply })
        : Phase.cases.ReadyToPublish.make({ reply }),
    ReadyAwaitingFeedbackCommit: () => state.phase,
    WaitingVisibly: ({ notBefore }) => Phase.cases.HoldingReply.make({ reply, notBefore }),
    HoldingReply: () => state.phase,
  });

// These are publication phases, not request states. Feedback's minimum duration
// starts at its React commit; request completion never advances display history.
const reducePublication = (state: Publication, event: typeof Event.Type): Publication =>
  Event.match(event, {
    Start: ({ intent, now }) => ({
      ...state,
      intent,
      phase: Intent.guards.Retry(intent)
        ? Phase.cases.AwaitingFeedbackCommit.make({})
        : replacementPhase(state.phase, now),
    }),
    Completed: ({ token, exit }) =>
      token === state.intent.token
        ? {
            ...state,
            phase: Exit.match(exit, {
              onSuccess: (reply) => successPhase(state, reply),
              onFailure: (cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Phase.cases.Settled.make({})
                  : Phase.cases.Failed.make({ error: safeRequestFailure(cause) }),
            }),
          }
        : state,
    Wake: ({ token, now }) => {
      if (token !== state.intent.token) return state;
      return {
        ...state,
        phase: Phase.match(state.phase, {
          AwaitingInitial: () => state.phase,
          Settled: () => state.phase,
          Failed: () => state.phase,
          ReadyToPublish: () => state.phase,
          AwaitingFeedbackCommit: () => state.phase,
          ReadyAwaitingFeedbackCommit: () => state.phase,
          WaitingSilently: ({ feedbackAt }) =>
            now >= feedbackAt ? Phase.cases.AwaitingFeedbackCommit.make({}) : state.phase,
          WaitingVisibly: () => state.phase,
          HoldingReply: ({ notBefore, reply }) =>
            now >= notBefore ? Phase.cases.ReadyToPublish.make({ reply }) : state.phase,
        }),
      };
    },
    FeedbackCommitted: ({ token, now }) => {
      if (token !== state.intent.token) return state;
      if (Phase.guards.AwaitingFeedbackCommit(state.phase))
        return { ...state, phase: Phase.cases.WaitingVisibly.make({ notBefore: now + 250 }) };
      if (Phase.guards.ReadyAwaitingFeedbackCommit(state.phase))
        return {
          ...state,
          phase: Phase.cases.HoldingReply.make({ reply: state.phase.reply, notBefore: now + 250 }),
        };
      return state;
    },
    DisplayCommitted: ({ token, reply, animate }) => {
      // This is an actual DOM commit, not a request completion. A newer intent
      // must not erase the comparison baseline React really displayed.
      if (Option.isSome(state.committed) && state.committed.value.token === token) return state;
      const display = replaceDisplayed(Option.getOrUndefined(state.committed)?.display, reply);
      return {
        ...state,
        committed: Option.some({ token, display, animate }),
        phase:
          token === state.intent.token && Phase.guards.ReadyToPublish(state.phase)
            ? Phase.cases.Settled.make({})
            : state.phase,
      };
    },
  });

const wakeDeadline = Phase.match({
  AwaitingInitial: () => undefined,
  Settled: () => undefined,
  Failed: () => undefined,
  ReadyToPublish: () => undefined,
  AwaitingFeedbackCommit: () => undefined,
  ReadyAwaitingFeedbackCommit: () => undefined,
  WaitingSilently: ({ feedbackAt }) => feedbackAt,
  WaitingVisibly: () => undefined,
  HoldingReply: ({ notBefore }) => notBefore,
});
const isPending = Phase.match({
  AwaitingInitial: () => false,
  Settled: () => false,
  Failed: () => false,
  ReadyToPublish: () => false,
  WaitingSilently: () => true,
  AwaitingFeedbackCommit: () => true,
  ReadyAwaitingFeedbackCommit: () => true,
  WaitingVisibly: () => true,
  HoldingReply: () => true,
});
const requestedRequest = Intent.match<typeof ClassifyRequest.Type>({
  Initial: () => ({ panelId: initialPanelId }),
  Panel: ({ request }) => request,
  Retry: ({ request }) => request,
});
const intentMotion = Intent.match({
  Initial: () => false,
  Panel: ({ animate }) => animate,
  Retry: ({ animate }) => animate,
});
const genericInternalFailure = ClassificationFailure.cases.InternalFailure.make({});
const safeRequestFailure = (cause: Cause.Cause<RequestFailure>): RequestFailure =>
  Cause.hasDies(cause)
    ? genericInternalFailure
    : Option.getOrElse(Cause.findErrorOption(cause), () => genericInternalFailure);

const presentPublication = (state: Publication) => {
  const token = state.intent.token;
  const candidate = Phase.guards.ReadyToPublish(state.phase)
    ? Option.some({
        token,
        display: replaceDisplayed(
          Option.getOrUndefined(state.committed)?.display,
          state.phase.reply,
        ),
        animate: intentMotion(state.intent),
      })
    : state.committed;
  const pending = isPending(state.phase);
  const visible = pending && !Phase.guards.WaitingSilently(state.phase);
  const failure = Phase.guards.Failed(state.phase)
    ? state.phase.error
    : pending && Intent.guards.Retry(state.intent)
      ? state.intent.error
      : undefined;
  return {
    initialActive: Intent.guards.Initial(state.intent),
    awaitingInitial: Phase.guards.AwaitingInitial(state.phase),
    request: requestedRequest(state.intent),
    committed: state.committed,
    candidate,
    pending,
    visible,
    failure,
    token,
    retrying: pending && Intent.guards.Retry(state.intent),
  };
};

/**
 * Publishes the latest intent with a 150ms feedback grace and a 250ms minimum
 * from feedback commit. Failures bypass delays; superseded successes are ignored.
 * Requests and timers are cancelled on unmount, independently of display history.
 * The intent retains the request so retries preserve an explicit refresh.
 */
export const usePanelPresentation = () => {
  const [state, dispatch] = useReducer(reducePublication, undefined, initialPublication);
  const run = useAtomSet(selectPanelAtom, { mode: "promiseExit" });
  const interrupt = useAtomSet(selectPanelAtom);
  const start = useCallback(
    (request: typeof ClassifyRequest.Type, animate: boolean, retryError?: RequestFailure): void => {
      const token = Symbol();
      const intent =
        retryError === undefined
          ? Intent.cases.Panel.make({ token, request, animate })
          : Intent.cases.Retry.make({ token, request, animate, error: retryError });
      dispatch(Event.cases.Start.make({ intent, now: performance.now() }));
      void run(request).then(
        (exit) => dispatch(Event.cases.Completed.make({ token, exit })),
        () =>
          dispatch(Event.cases.Completed.make({ token, exit: Exit.fail(genericInternalFailure) })),
      );
    },
    [run],
  );
  const reportInitial = useCallback(
    (token: symbol, result: AsyncResult.AsyncResult<PanelResponse, RequestFailure>): void => {
      if (AsyncResult.isWaiting(result)) return;
      AsyncResult.match(result, {
        onInitial: () => undefined,
        onSuccess: ({ value }) =>
          dispatch(Event.cases.Completed.make({ token, exit: Exit.succeed(value) })),
        onFailure: ({ cause }) =>
          dispatch(Event.cases.Completed.make({ token, exit: Exit.failCause(cause) })),
      });
    },
    [],
  );
  const feedbackCommitted = useCallback((token: symbol): void => {
    dispatch(Event.cases.FeedbackCommitted.make({ token, now: performance.now() }));
  }, []);
  const displayCommitted = useCallback((candidate: PublicationCandidate): void => {
    dispatch(
      Event.cases.DisplayCommitted.make({
        token: candidate.token,
        reply: candidate.display.response,
        animate: candidate.animate,
      }),
    );
  }, []);
  const deadline = wakeDeadline(state.phase);
  const token = state.intent.token;
  useEffect(() => {
    if (deadline === undefined) return;
    let timer: number;
    const wake = (): void => {
      const now = performance.now();
      if (now < deadline) {
        timer = window.setTimeout(wake, Math.ceil(deadline - now));
      } else {
        dispatch(Event.cases.Wake.make({ token, now }));
      }
    };
    timer = window.setTimeout(wake, Math.max(0, Math.ceil(deadline - performance.now())));
    return () => window.clearTimeout(timer);
  }, [deadline, token]);
  useEffect(() => () => interrupt(Atom.Interrupt), [interrupt]);

  return {
    ...presentPublication(state),
    start,
    reportInitial,
    feedbackCommitted,
    displayCommitted,
  };
};
