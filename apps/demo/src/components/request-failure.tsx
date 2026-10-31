"use client";

import { Button } from "@base-ui/react/button";
import { DateTime } from "effect";
import { RequestFailure } from "../client/panel-atoms.ts";
import { PublicModelReason } from "../lib/contract.ts";
import styles from "./request-failure.module.css";

const authenticationMessages = {
  InvalidKey: "Set a valid API key, then try again.",
  ExpiredKey: "Replace the expired API key, then try again.",
  MissingKey: "Set an API key, then try again.",
  InsufficientPermissions: "Give the API key permission to use this model, then try again.",
  Unknown: "Check the API key and its permissions, then try again.",
} satisfies Record<(typeof PublicModelReason.cases.AuthenticationError.Type)["kind"], string>;

interface FailureDetails {
  readonly message: string;
  readonly retry: boolean;
  readonly requestId?: string | undefined;
}

const providerMessage = (message: string, retryable: boolean) =>
  `${message} ${retryable ? "Try again." : "Contact the site administrator."}`;

const describeFailure = (error: RequestFailure): FailureDetails =>
  RequestFailure.match<FailureDetails>(error, {
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
          message: providerMessage("The model service could not finish the request.", retryable),
          retry: retryable,
        }),
        NetworkError: () => ({
          message: providerMessage("Could not reach the model service.", retryable),
          retry: retryable,
        }),
        InvalidOutputError: () => ({
          message: providerMessage("Could not use the model's reply.", retryable),
          retry: retryable,
        }),
        StructuredOutputError: () => ({
          message: providerMessage(
            "The model's reply did not match the required format.",
            retryable,
          ),
          retry: retryable,
        }),
        UnsupportedSchemaError: () => ({
          message: "Choose a reply format that the model supports before you try again.",
          retry: false,
        }),
        UnknownError: () => ({
          message: providerMessage("Could not complete the model request.", retryable),
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

/** Explains safe request failures, retaining the retry control while a retry is pending. */
export const RequestFailureView = ({
  error,
  context,
  pending,
  onRetry,
}: {
  readonly error: RequestFailure;
  readonly context: string;
  readonly pending?: string | undefined;
  readonly onRetry: (animate: boolean) => void;
}) => {
  const details = describeFailure(error);
  return (
    <div className={styles.failure} role={pending === undefined ? "alert" : undefined}>
      <p aria-hidden={pending !== undefined}>{pending ?? context}</p>
      <details open>
        <summary>Request details</summary>
        <div className={styles.details}>
          {pending === undefined && (
            <>
              <p className={styles.message}>{details.message}</p>
              {details.requestId !== undefined && <p>Request ID: {details.requestId}</p>}
            </>
          )}
          {details.retry && (
            <Button
              className={styles.retry}
              aria-disabled={pending !== undefined}
              onClick={(event) => {
                if (pending === undefined) onRetry(event.detail > 0);
              }}
            >
              Try again
            </Button>
          )}
        </div>
      </details>
    </div>
  );
};
