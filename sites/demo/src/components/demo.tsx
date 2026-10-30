"use client";

import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { panels, records } from "../lib/catalog.ts";
import { Comparison, formatSampleShare } from "../lib/display.ts";
import { RequestFailureView } from "./request-failure.tsx";
import { RequestFeedback } from "./request-feedback.tsx";
import {
  type PublicationCandidate,
  usePanelPresentation,
} from "../client/use-panel-presentation.ts";
import { AbundanceChart } from "./abundance-chart.tsx";
import { RecordMatches } from "./record-matches.tsx";
import { ThemeControl } from "./theme-control.tsx";
import { PanelControls } from "./panel-controls.tsx";
import { RecordControls } from "./record-controls.tsx";
import styles from "./demo.module.css";
import { initialQueryAtom, recordSelectionAtom } from "../client/panel-atoms.ts";

const SuccessfulResults = ({
  candidate,
  onCommit,
}: {
  readonly candidate: PublicationCandidate;
  readonly onCommit: (candidate: PublicationCandidate) => void;
}) => {
  const { display, animate } = candidate;
  const { response, findings } = display;
  const selection = useAtomValue(recordSelectionAtom);
  const recordId = Option.getOrUndefined(selection)?.recordId;
  const record = records.find((entry) => entry.id === recordId);
  useLayoutEffect(() => {
    onCommit(candidate);
  }, [candidate, onCommit]);
  return (
    <section className={styles.workspace} aria-label={findings.panel.name}>
      <RecordMatches findings={findings} />
      <section className={styles.chartSection} aria-labelledby="panel-targets">
        <div className={styles.sectionTop}>
          <h2 id="panel-targets">Panel targets</h2>
          <span className={styles.sectionMeta}>{findings.panel.targets.length} targets</span>
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
            {Comparison.match(display.comparison, {
              FirstDisplay: () => null,
              Compared: ({ changedRecords, panelName }) => (
                <span>
                  Matches changed for {changedRecords} records since {panelName}.
                </span>
              ),
            })}
          </p>
        </div>
        <AbundanceChart findings={findings} revision={candidate.token} animatePanels={animate} />
      </section>
    </section>
  );
};

const InitialReader = ({
  token,
  awaitingInitial,
  reportInitial,
}: {
  readonly token: symbol;
  readonly awaitingInitial: boolean;
  readonly reportInitial: ReturnType<typeof usePanelPresentation>["reportInitial"];
}) => {
  const result = useAtomValue(initialQueryAtom);
  useLayoutEffect(() => reportInitial(token, result), [token, result, reportInitial]);
  return awaitingInitial ? <p role="status">Classifying with Broad groups…</p> : null;
};

const CommittedFeedback = ({
  token,
  onCommit,
  children,
}: {
  readonly token: symbol;
  readonly onCommit: (token: symbol) => void;
  readonly children: ReactNode;
}) => {
  useLayoutEffect(() => onCommit(token), [token, onCommit]);
  return children;
};

/** Classifies catalog panels while retaining committed results and record inspection. */
export const Demo = () => {
  const selectedPanel = useRef<HTMLInputElement>(null);
  const {
    initialActive,
    awaitingInitial,
    requested,
    committed,
    candidate,
    pending,
    visible,
    failure,
    token,
    retrying,
    start,
    reportInitial,
    feedbackCommitted,
    displayCommitted,
  } = usePanelPresentation();
  const response =
    pending || failure !== undefined || initialActive
      ? undefined
      : Option.getOrUndefined(candidate)?.display.response;
  const requestedName = panels.find((panel) => panel.id === requested)?.name;
  const retained = Option.match(committed, {
    onNone: () => "No panel results have been displayed yet.",
    onSome: ({ display }) =>
      `Still showing ${panels.find((panel) => panel.id === display.response.panelId)?.name}.`,
  });
  const progress = `${retrying ? "Retrying" : "Updating to"} ${requestedName}. ${retained}`;
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
            <PanelControls selected={requested} onSelect={start} selectedInputRef={selectedPanel} />
            <RecordControls />
          </div>
          <div className={styles.appearance}>
            <ThemeControl />
          </div>
        </aside>
        <div className={styles.results} aria-busy={pending || awaitingInitial}>
          {initialActive && (
            <InitialReader
              token={token}
              awaitingInitial={awaitingInitial}
              reportInitial={reportInitial}
            />
          )}
          {Option.match(candidate, {
            onNone: () => null,
            onSome: (value) => <SuccessfulResults candidate={value} onCommit={displayCommitted} />,
          })}
        </div>
      </div>
      <div role="status" aria-atomic="true" className={styles.announcer}>
        {visible && failure === undefined && (
          <CommittedFeedback token={token} onCommit={feedbackCommitted}>
            <RequestFeedback returnFocusRef={selectedPanel}>
              <p>{progress}</p>
            </RequestFeedback>
          </CommittedFeedback>
        )}
        {visible && failure !== undefined && <p className={styles.announcement}>{progress}</p>}
        {response !== undefined && (
          <p className={styles.announcement}>
            {panels.find((panel) => panel.id === response.panelId)?.name} results displayed.
          </p>
        )}
      </div>
      {failure !== undefined && (
        <CommittedFeedback token={token} onCommit={feedbackCommitted}>
          <RequestFeedback returnFocusRef={selectedPanel}>
            <RequestFailureView
              error={failure}
              context={`Could not update ${requestedName}. ${retained}`}
              pending={visible ? progress : undefined}
              onRetry={(animate) => start(requested, animate, failure)}
            />
          </RequestFeedback>
        </CommittedFeedback>
      )}
    </main>
  );
};
