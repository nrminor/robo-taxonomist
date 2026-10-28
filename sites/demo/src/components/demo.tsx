"use client";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@base-ui/react/button";
import { Cause, Option, Result, Schema } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Suspense, use, useLayoutEffect } from "react";
import { panels } from "../lib/catalog.ts";
import { PanelResponse } from "../lib/contract.ts";
import { replaceDisplayed } from "../lib/display.ts";
import { RequestFailureView } from "./request-failure.tsx";
import { AbundanceChart } from "./abundance-chart.tsx";
import { RecordMatches } from "./record-matches.tsx";
import styles from "./demo.module.css";
import {
  decodeReply,
  displayedAtom,
  selectedPanelId,
  selectionAtom,
  Selection,
  selectPanelAtom,
} from "../client/panel-atoms.ts";

function PanelControls() {
  const selection = useAtomValue(selectionAtom);
  const choose = useAtomSet(selectionAtom);
  const run = useAtomSet(selectPanelAtom);
  return (
    <>
      <div role="group" aria-label="Choose a panel" className={styles.panelControls}>
        {panels.map((panel) => (
          <Button
            key={panel.id}
            aria-pressed={selectedPanelId(selection) === panel.id}
            onClick={() => {
              choose(Selection.cases.Panel.make({ panelId: panel.id }));
              run(panel.id);
            }}
          >
            {panel.name}
          </Button>
        ))}
      </div>
      <p className={styles.panelDescription}>
        {panels.find((panel) => panel.id === selectedPanelId(selection))?.description}
      </p>
    </>
  );
}

function SuccessfulResults({ response }: { readonly response: PanelResponse }) {
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
    <section>
      <div className={styles.resultHeader}>
        <h2>{panels.find((panel) => panel.id === response.panelId)?.name}</h2>
        <p>
          {display.matchedRecords} of {response.rows.length} records match a target.
        </p>
        {display.changedRecords !== undefined && (
          <p>
            Matches changed for {display.changedRecords} records since{" "}
            {panels.find((panel) => panel.id === display.comparedWith)?.name}.
          </p>
        )}
      </div>
      <div className={styles.workspace}>
        <section className={styles.chart} aria-labelledby="count-abundance">
          <h3 id="count-abundance">Count abundance for each target</h3>
          <p>Keep the same sample total when you compare panels.</p>
          <AbundanceChart response={response} />
        </section>
        <RecordMatches response={response} />
      </div>
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
    <div aria-busy={request.waiting}>
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
    <Suspense fallback={<p role="status">Classifying with Broad survey…</p>}>
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
      <header className={styles.header}>
        <span className={styles.brand}>robo-taxonomist</span>
        <a href="https://github.com/nrminor/robo-taxonomist">View source</a>
      </header>
      <h1>Classify each record</h1>
      <p className={styles.intro}>Choose a panel to see which taxa match each record.</p>
      <p className={styles.example}>
        Try 24 synthetic records. We supplied the answers for this example.
      </p>
      <PanelControls />
      <Results initial={initial} />
    </main>
  );
}
