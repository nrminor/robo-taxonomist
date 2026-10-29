"use client";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option, Result, Schema } from "effect";
import { Suspense, use, useLayoutEffect, useState } from "react";
import { initialPanelId, panels, records } from "../lib/catalog.ts";
import { PanelResponse } from "../lib/contract.ts";
import { formatSampleShare, replaceDisplayed } from "../lib/display.ts";
import { RequestFailureView } from "./request-failure.tsx";
import { RequestFeedback } from "./request-feedback.tsx";
import { usePanelPresentation } from "../client/use-panel-presentation.ts";
import { AbundanceChart } from "./abundance-chart.tsx";
import { RecordMatches } from "./record-matches.tsx";
import { ThemeControl } from "./theme-control.tsx";
import { PanelControls } from "./panel-controls.tsx";
import { RecordControls } from "./record-controls.tsx";
import styles from "./demo.module.css";
import {
  decodeReply,
  displayedAtom,
  selectionAtom,
  Selection,
  recordSelectionAtom,
  type RequestFailure,
} from "../client/panel-atoms.ts";

function SuccessfulResults({ response }: { readonly response: PanelResponse }) {
  const selection = useAtomValue(recordSelectionAtom);
  const recordId = Option.getOrUndefined(selection)?.recordId;
  const record = records.find((entry) => entry.id === recordId);
  const previous = useAtomValue(displayedAtom);
  const remember = useAtomSet(displayedAtom);
  const display = replaceDisplayed(Option.getOrUndefined(previous), response);
  useLayoutEffect(() => {
    remember((current) => {
      const next = replaceDisplayed(Option.getOrUndefined(current), response);
      return Option.isSome(current) && current.value === next ? current : Option.some(next);
    });
  }, [remember, response]);
  return (
    <section
      className={styles.workspace}
      aria-label={panels.find((panel) => panel.id === response.panelId)?.name}
    >
      <RecordMatches response={response} />
      <section className={styles.chartSection} aria-labelledby="panel-targets">
        <div className={styles.sectionTop}>
          <h2 id="panel-targets">Panel targets</h2>
          <span className={styles.sectionMeta}>
            {panels.find((panel) => panel.id === response.panelId)?.targets.length} targets
          </span>
        </div>
        <div className={styles.resultSummary}>
          <p className={styles.chartInspection}>
            {record === undefined
              ? "Select an input record to inspect its matches."
              : `Selected record: ${record.name} · ${formatSampleShare(record.abundance)} of sample`}
          </p>
          <p>
            <span>
              {display.matchedRecords} of {response.rows.length} records match a target.
            </span>{" "}
            {display.changedRecords !== undefined && (
              <span>
                Matches changed for {display.changedRecords} records since{" "}
                {panels.find((panel) => panel.id === display.comparedWith)?.name}.
              </span>
            )}
          </p>
        </div>
        <AbundanceChart response={response} />
      </section>
    </section>
  );
}

function ResolvedResults({
  initial,
  selection,
  response,
  busy,
  reportInitial,
}: {
  readonly initial: Promise<Schema.Json>;
  readonly selection: typeof Selection.Type;
  readonly response: PanelResponse | undefined;
  readonly busy: boolean;
  readonly reportInitial: (reply: Result.Result<PanelResponse, RequestFailure>) => void;
}) {
  const displayed = useAtomValue(displayedAtom);
  const previousResponse = Option.map(displayed, (display) => display.response);
  const initialWire = Selection.guards.Initial(selection) ? use(initial) : undefined;
  const [decodedInitial, setDecodedInitial] = useState(() =>
    initialWire === undefined ? undefined : { source: initial, reply: decodeReply(initialWire) },
  );
  const initialReply =
    initialWire === undefined || decodedInitial?.source !== initial
      ? undefined
      : decodedInitial.reply;
  useLayoutEffect(() => {
    if (initialReply !== undefined) reportInitial(initialReply);
  }, [initialReply, reportInitial]);
  if (initialWire !== undefined && decodedInitial?.source !== initial) {
    setDecodedInitial({ source: initial, reply: decodeReply(initialWire) });
    return null;
  }
  const candidate =
    initialReply !== undefined
      ? Result.match(initialReply, { onFailure: () => Option.none(), onSuccess: Option.some })
      : busy || response === undefined
        ? previousResponse
        : Option.some(response);
  return (
    <div className={styles.results} aria-busy={busy}>
      {Option.match(candidate, {
        onNone: () => null,
        onSome: (response) => <SuccessfulResults response={response} />,
      })}
    </div>
  );
}

function Results({
  initial,
  response,
  busy,
  reportInitial,
}: {
  readonly initial: Promise<Schema.Json>;
  readonly response: PanelResponse | undefined;
  readonly busy: boolean;
  readonly reportInitial: (reply: Result.Result<PanelResponse, RequestFailure>) => void;
}) {
  const selection = useAtomValue(selectionAtom);
  return (
    <Suspense fallback={<p role="status">Classifying with Broad groups…</p>}>
      <ResolvedResults
        initial={initial}
        selection={selection}
        response={response}
        busy={busy}
        reportInitial={reportInitial}
      />
    </Suspense>
  );
}

export function Demo({ initial }: { readonly initial: Promise<Schema.Json> }) {
  const { presentation, start, reportInitial } = usePanelPresentation();
  const displayed = useAtomValue(displayedAtom);
  const pending = presentation.kind === "pending" ? presentation : undefined;
  const response = presentation.kind === "success" ? presentation.response : undefined;
  const failure = presentation.kind === "failure" ? presentation.error : pending?.retryError;
  const requested =
    presentation.kind === "failure" || presentation.kind === "pending"
      ? presentation.panelId
      : initialPanelId;
  const requestedName = panels.find((panel) => panel.id === requested)?.name;
  const retained = Option.match(displayed, {
    onNone: () => "No panel results have been displayed yet.",
    onSome: (display) =>
      `Still showing ${panels.find((panel) => panel.id === display.response.panelId)?.name}.`,
  });
  const progress = `${pending?.retryError === undefined ? "Updating to" : "Retrying"} ${requestedName}. ${retained}`;
  return (
    <main className={styles.shell}>
      <header>
        <h1>robo-taxonomist demo</h1>
        <p className={styles.intro}>
          Each input record contains a taxonomic name and its share of the sample. Choose one of
          three panels containing different numbers of target taxa, including broad groups and
          nested subgroups. Every record is checked against every target in the selected panel and
          can match more than one.
        </p>
      </header>
      <div className={styles.layout}>
        <aside className={styles.controls} aria-label="Classification controls">
          <div className={styles.controlOptions}>
            <PanelControls onSelect={start} />
            <RecordControls />
          </div>
          <div className={styles.appearance}>
            <ThemeControl />
          </div>
        </aside>
        <Results
          initial={initial}
          response={response}
          busy={pending !== undefined}
          reportInitial={reportInitial}
        />
      </div>
      <div role="status" aria-atomic="true" className={styles.announcer}>
        {pending?.visible && failure === undefined && (
          <RequestFeedback>
            <p>{progress}</p>
          </RequestFeedback>
        )}
        {pending?.visible && failure !== undefined && (
          <p className={styles.announcement}>{progress}</p>
        )}
        {response !== undefined && (
          <p className={styles.announcement}>
            {panels.find((panel) => panel.id === response.panelId)?.name} results displayed.
          </p>
        )}
      </div>
      {failure !== undefined && (
        <RequestFeedback>
          <RequestFailureView
            error={failure}
            context={`Could not update ${requestedName}. ${retained}`}
            pending={pending?.visible ? progress : undefined}
            onRetry={() => start(requested, failure)}
          />
        </RequestFeedback>
      )}
    </main>
  );
}
