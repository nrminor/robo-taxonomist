"use client";

import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit, Option, Result } from "effect";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { initialPanelId, type PanelId } from "../lib/catalog.ts";
import { ClassificationFailure, type PanelResponse } from "../lib/contract.ts";
import { type RequestFailure, Selection, selectionAtom, selectPanelAtom } from "./panel-atoms.ts";

type Presentation =
  | { kind: "idle" }
  | {
      kind: "pending";
      attempt: number;
      panelId: PanelId;
      visible: boolean;
      retryError?: RequestFailure;
    }
  | { kind: "success"; response: PanelResponse }
  | { kind: "failure"; panelId: PanelId; error: RequestFailure };

type Attempt = {
  generation: number;
  panelId: PanelId;
  graceDeadline: number;
  visible: boolean;
  retryError: RequestFailure | undefined;
  shownAt: number | undefined;
  response: PanelResponse | undefined;
  graceTimer: number | undefined;
  minimumTimer: number | undefined;
};

const genericInternalFailure = ClassificationFailure.cases.InternalFailure.make({});

function safeRequestFailure(cause: Cause.Cause<RequestFailure>): RequestFailure {
  if (Cause.hasDies(cause)) return genericInternalFailure;
  return Option.getOrElse(Cause.findErrorOption(cause), () => genericInternalFailure);
}

function clearTimers(attempt: Attempt): void {
  window.clearTimeout(attempt.graceTimer);
  window.clearTimeout(attempt.minimumTimer);
  attempt.graceTimer = undefined;
  attempt.minimumTimer = undefined;
}

function pending(attempt: Attempt): Presentation {
  return {
    kind: "pending",
    attempt: attempt.generation,
    panelId: attempt.panelId,
    visible: attempt.visible,
    ...(attempt.retryError === undefined ? {} : { retryError: attempt.retryError }),
  };
}

export function usePanelPresentation() {
  const choose = useAtomSet(selectionAtom);
  const run = useAtomSet(selectPanelAtom, { mode: "promiseExit" });
  const [presentation, setPresentation] = useState<Presentation>({ kind: "idle" });
  const generation = useRef(0);
  const current = useRef<Attempt | undefined>(undefined);

  const publishSuccess = useCallback(function publishSuccess(attempt: Attempt): void {
    if (current.current !== attempt || attempt.response === undefined) return;
    // A retry keeps the existing feedback card, even if the reply precedes its commit.
    if (attempt.shownAt === undefined && attempt.retryError !== undefined) return;
    const remaining = attempt.shownAt === undefined ? 0 : attempt.shownAt + 250 - performance.now();
    if (remaining > 0) {
      window.clearTimeout(attempt.minimumTimer);
      attempt.minimumTimer = window.setTimeout(() => publishSuccess(attempt), remaining);
      return;
    }
    clearTimers(attempt);
    current.current = undefined;
    setPresentation({ kind: "success", response: attempt.response });
  }, []);

  const start = useCallback(
    (panelId: PanelId, retryError?: RequestFailure): void => {
      const previous = current.current;
      if (previous !== undefined) clearTimers(previous);
      const attempt: Attempt = {
        generation: ++generation.current,
        panelId,
        graceDeadline: previous?.graceDeadline ?? performance.now() + 150,
        visible: retryError !== undefined || (previous?.visible ?? false),
        retryError,
        shownAt: retryError === undefined ? previous?.shownAt : undefined,
        response: undefined,
        graceTimer: undefined,
        minimumTimer: undefined,
      };
      current.current = attempt;
      setPresentation(pending(attempt));
      choose(Selection.cases.Panel.make({ panelId }));
      const completion = run(panelId);

      if (!attempt.visible) {
        attempt.graceTimer = window.setTimeout(
          () => {
            if (current.current !== attempt) return;
            attempt.graceTimer = undefined;
            attempt.visible = true;
            setPresentation(pending(attempt));
          },
          Math.max(0, attempt.graceDeadline - performance.now()),
        );
      }

      void completion.then(
        (exit) => {
          // Atom result promises may follow a replacement request, not their original fiber.
          if (current.current !== attempt) return;
          window.clearTimeout(attempt.graceTimer);
          attempt.graceTimer = undefined;
          if (Exit.isSuccess(exit)) {
            attempt.response = exit.value;
            publishSuccess(attempt);
            return;
          }
          clearTimers(attempt);
          current.current = undefined;
          setPresentation(
            Cause.hasInterruptsOnly(exit.cause)
              ? { kind: "idle" }
              : { kind: "failure", panelId, error: safeRequestFailure(exit.cause) },
          );
        },
        () => {
          if (current.current !== attempt) return;
          clearTimers(attempt);
          current.current = undefined;
          setPresentation({ kind: "failure", panelId, error: genericInternalFailure });
        },
      );
    },
    [choose, run, publishSuccess],
  );

  const reportInitial = useCallback((reply: Result.Result<PanelResponse, RequestFailure>): void => {
    if (generation.current !== 0) return;
    setPresentation(
      Result.isFailure(reply)
        ? { kind: "failure", panelId: initialPanelId, error: reply.failure }
        : { kind: "idle" },
    );
  }, []);

  useLayoutEffect(() => {
    const attempt = current.current;
    if (
      presentation.kind !== "pending" ||
      !presentation.visible ||
      attempt === undefined ||
      attempt.generation !== presentation.attempt
    ) {
      return;
    }
    attempt.shownAt ??= performance.now();
    publishSuccess(attempt);
  }, [presentation, publishSuccess]);

  useEffect(
    () => () => {
      if (current.current !== undefined) clearTimers(current.current);
      current.current = undefined;
    },
    [],
  );

  return { presentation, start, reportInitial };
}
