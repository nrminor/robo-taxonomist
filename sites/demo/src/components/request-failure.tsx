"use client";

import { Button } from "@base-ui/react/button";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DateTime } from "effect";
import {
  RequestFailure,
  selectedPanelId,
  selectionAtom,
  Selection,
  selectPanelAtom,
} from "../client/panel-atoms.ts";
import { PublicModelReason } from "../lib/contract.ts";
import styles from "./request-failure.module.css";

const authenticationMessages = {
  InvalidKey: "Set a valid API key, then try again.",
  ExpiredKey: "Replace the expired API key, then try again.",
  MissingKey: "Set an API key, then try again.",
  InsufficientPermissions: "Give the API key permission to use this model, then try again.",
  Unknown: "Check the API key and its permissions, then try again.",
} satisfies Record<(typeof PublicModelReason.cases.AuthenticationError.Type)["kind"], string>;

export function RequestFailureView({ error }: { readonly error: RequestFailure }) {
  const selection = useAtomValue(selectionAtom);
  const choose = useAtomSet(selectionAtom);
  const run = useAtomSet(selectPanelAtom);
  const details: {
    readonly message: string;
    readonly retry: boolean;
    readonly requestId?: string | undefined;
  } = RequestFailure.match(error, {
    ModelFailure: ({ reason, retryable, requestId }) => ({
      ...PublicModelReason.match(reason, {
        RateLimitError: ({ retryAfterMs }) => ({
          message:
            retryAfterMs === undefined
              ? "Wait before you try again."
              : `Wait ${Math.ceil(retryAfterMs / 1000)} seconds before you try again.`,
          retry: retryable,
        }),
        QuotaExhaustedError: ({ resetAt }) => ({
          message:
            resetAt === undefined
              ? "Check the API usage limit before you try again."
              : `Wait until ${DateTime.formatIso(resetAt)} for the API usage limit to reset.`,
          retry: false,
        }),
        AuthenticationError: ({ kind }) => ({
          message: authenticationMessages[kind],
          retry: false,
        }),
        ContentPolicyError: () => ({
          message: "Change the input to meet the model's content rules before you try again.",
          retry: false,
        }),
        InvalidRequestError: () => ({
          message: "Check the model request settings before you try again.",
          retry: false,
        }),
        InternalProviderError: () => ({
          message: retryable
            ? "The model service could not finish the request. Try again."
            : "The model service could not finish the request. Contact the site administrator.",
          retry: retryable,
        }),
        NetworkError: () => ({
          message: retryable
            ? "Could not reach the model service. Try again."
            : "Could not reach the model service. Contact the site administrator.",
          retry: retryable,
        }),
        InvalidOutputError: () => ({
          message: retryable
            ? "Could not use the model's reply. Try again."
            : "Could not use the model's reply. Contact the site administrator.",
          retry: retryable,
        }),
        StructuredOutputError: () => ({
          message: retryable
            ? "The model's reply did not match the required format. Try again."
            : "The model's reply did not match the required format. Contact the site administrator.",
          retry: retryable,
        }),
        UnsupportedSchemaError: () => ({
          message: "Choose a reply format that the model supports before you try again.",
          retry: false,
        }),
        UnknownError: () => ({
          message: retryable
            ? "Could not complete the model request. Try again."
            : "Could not complete the model request. Contact the site administrator.",
          retry: retryable,
        }),
        ToolNotFoundError: () => ({
          message: "Add the missing model tool before you try again.",
          retry: false,
        }),
        ToolParameterValidationError: () => ({
          message: "Fix the model tool's input before you try again.",
          retry: false,
        }),
        InvalidToolResultError: () => ({
          message: "Fix the model tool's reply before you try again.",
          retry: false,
        }),
        ToolResultEncodingError: () => ({
          message: "Fix how the model tool encodes its reply before you try again.",
          retry: false,
        }),
        ToolConfigurationError: () => ({
          message: "Check the model tool's settings before you try again.",
          retry: false,
        }),
        ToolkitRequiredError: () => ({
          message: "Set up the tools required by the model before you try again.",
          retry: false,
        }),
        InvalidUserInputError: () => ({
          message: "Correct the input sent to the model before you try again.",
          retry: false,
        }),
      }),
      requestId,
    }),
    InvalidPanel: () => ({ message: "Choose one of the listed panels.", retry: false }),
    ConfigurationFailure: ({ requestId }) => ({
      message: "Ask the site administrator to check the model settings before you try again.",
      retry: false,
      requestId,
    }),
    InternalFailure: ({ requestId }) => ({
      message: "Could not classify this panel. Contact the site administrator.",
      retry: false,
      requestId,
    }),
    TransportFailure: () => ({
      message: "Could not complete the request. Check your connection, then try again.",
      retry: true,
    }),
    ResponseDecodingFailure: () => ({
      message: "Could not read the reply. Try again.",
      retry: true,
    }),
  });

  return (
    <aside role="alert" className={styles.failure}>
      <p>{details.message}</p>
      {details.requestId !== undefined && <p>Request ID: {details.requestId}</p>}
      {details.retry && (
        <Button
          className={styles.retry}
          onClick={() => {
            const panelId = selectedPanelId(selection);
            choose(Selection.cases.Panel.make({ panelId }));
            run(panelId);
          }}
        >
          Try again
        </Button>
      )}
    </aside>
  );
}
