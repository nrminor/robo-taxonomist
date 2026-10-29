"use client";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Option, Result, Schema } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Suspense, use, useLayoutEffect } from "react";
import { panels, records } from "../lib/catalog.ts";
import { PanelResponse } from "../lib/contract.ts";
import { formatSampleShare, replaceDisplayed } from "../lib/display.ts";
import { RequestFailureView } from "./request-failure.tsx";
import { AbundanceChart } from "./abundance-chart.tsx";
import { RecordMatches } from "./record-matches.tsx";
import { ThemeControl } from "./theme-control.tsx";
import { PanelControls } from "./panel-controls.tsx";
import { RecordControls } from "./record-controls.tsx";
import styles from "./demo.module.css";
import {
  decodeReply,
  displayedAtom,
  selectedPanelId,
  selectionAtom,
  Selection,
  selectPanelAtom,
  recordSelectionAtom,
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

function InitialResults({ initial }: { readonly initial: Promise<Schema.Json> }) {
  const reply = decodeReply(use(initial));
  return Result.match(reply, {
    onFailure: (error) => <RequestFailureView error={error} />,
    onSuccess: (response) => <SuccessfulResults response={response} />,
  });
}

function InteractiveResults() {
  const selection = useAtomValue(selectionAtom);
  const request = useAtomValue(selectPanelAtom);
  const displayed = useAtomValue(displayedAtom);
  const previousResponse = Option.map(displayed, (display) => display.response);
  const selected = panels.find((panel) => panel.id === selectedPanelId(selection));
  const candidate = request.waiting
    ? previousResponse
    : AsyncResult.match(request, {
        onInitial: () => previousResponse,
        onFailure: () => previousResponse,
        onSuccess: (success) => Option.some(success.value),
      });
  const failure = AsyncResult.matchWithError(request, {
    onInitial: () => null,
    onSuccess: () => null,
    onError: (error) => <RequestFailureView error={error} />,
    onDefect: () => <p role="alert">Could not complete the request.</p>,
  });
  return (
    <div className={styles.results} aria-busy={request.waiting}>
      {request.waiting && <p role="status">Classifying with {selected?.name}…</p>}
      {!request.waiting &&
        !(AsyncResult.isFailure(request) && Cause.hasInterruptsOnly(request.cause)) &&
        failure}
      {Option.match(candidate, {
        onNone: () => null,
        onSome: (response) => <SuccessfulResults response={response} />,
      })}
    </div>
  );
}

function Results({ initial }: { readonly initial: Promise<Schema.Json> }) {
  const selection = useAtomValue(selectionAtom);
  return (
    <Suspense fallback={<p role="status">Classifying with Broad groups…</p>}>
      {Selection.match(selection, {
        Initial: () => <InitialResults initial={initial} />,
        Panel: () => <InteractiveResults />,
      })}
    </Suspense>
  );
}

export function Demo({ initial }: { readonly initial: Promise<Schema.Json> }) {
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
            <PanelControls />
            <RecordControls />
          </div>
          <div className={styles.appearance}>
            <ThemeControl />
          </div>
        </aside>
        <Results initial={initial} />
      </div>
    </main>
  );
}
