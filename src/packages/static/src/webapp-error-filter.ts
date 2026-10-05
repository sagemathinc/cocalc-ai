import { extractRuntimeSponsorDenial } from "@cocalc/util/runtime-sponsor-denial";

const IGNORED_BROWSER_ERROR_MESSAGES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

export function isIgnorableBrowserError(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const normalized = message.trim();
  return (
    IGNORED_BROWSER_ERROR_MESSAGES.has(normalized) ||
    /ChunkLoadError|Loading (?:CSS )?chunk|__webpack_require__|__webpack_modules__/i.test(
      normalized,
    )
  );
}

export function isBrowserExtensionError({
  file,
  stacktrace,
}: {
  file?: unknown;
  stacktrace?: unknown;
}): boolean {
  return /(?:chrome|moz|safari-web)-extension:\/\//i.test(
    `${file ?? ""}\n${stacktrace ?? ""}`,
  );
}

function rejectionMessage(reason: unknown): string {
  if (typeof reason === "string") {
    return reason.trim().toLowerCase();
  }
  if (reason != null && typeof reason === "object") {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") {
      return message.trim().toLowerCase();
    }
  }
  return "";
}

function rejectionStack(reason: unknown): string {
  if (reason == null || typeof reason !== "object") {
    return "";
  }
  const stack = (reason as { stack?: unknown }).stack;
  return typeof stack === "string" ? stack : "";
}

function rejectionName(reason: unknown): string {
  if (reason == null || typeof reason !== "object") {
    return "";
  }
  const name = (reason as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

// Browsers reject a view transition's promises when they skip or abort its
// animation, e.g. "Skipping view transition because viewport size changed"
// (Safari) or "Transition was aborted because of invalid state" (Chrome).
function isSkippedViewTransition(reason: unknown, message: string): boolean {
  const name = rejectionName(reason);
  if (name && name !== "InvalidStateError" && name !== "AbortError") {
    return false;
  }
  return (
    message.includes("view transition") ||
    /^(?:(?:invalidstateerror|aborterror): )?transition was (?:aborted|skipped)/.test(
      message,
    )
  );
}

function rejectionCode(reason: unknown): string {
  if (reason == null || typeof reason !== "object") {
    return "";
  }
  const code = (reason as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${code}` : "";
}

export function isIgnorableUnhandledRejection(reason: unknown): boolean {
  if (extractRuntimeSponsorDenial(reason) != null) {
    return true;
  }
  const message = rejectionMessage(reason);
  if (!message) {
    return false;
  }
  const rootfsUnavailable =
    message.includes("rootfs is not mounted") &&
    message.includes("start the project and try again");
  const routingUnavailable =
    message.includes("unable to route") &&
    message.includes("'projectactions.fs'") &&
    message.includes("project-host") &&
    message.includes("host routing info unavailable");
  const conatInfoBootstrapTimeout =
    message.includes("once: timeout") &&
    (message.includes('waiting for "info"') ||
      message.includes("waiting for 'info'") ||
      message.includes("waiting for info"));
  const socketIoTransportClosed =
    message === "socket has been disconnected" ||
    message === "error: socket has been disconnected";
  const conatTransportClosed =
    message === "disconnected" ||
    message === "error: disconnected" ||
    /^error: once: ["'][^"']+["'] not emitted before ["']closed["']$/.test(
      message,
    ) ||
    /^once: ["'][^"']+["'] not emitted before ["']closed["']$/.test(message);
  const conatSocketRequestTimedOut =
    message === "request timed out" || message === "error: request timed out";
  const conatRequestTimedOut =
    rejectionCode(reason) === "408" &&
    (message === "timeout" ||
      (message.startsWith("timeout - ") && message.includes(" subject:")));
  const filesystemServerStarting = message === "file server not initialized";
  const staleCollaboratorAccess =
    message.includes("account '") &&
    message.includes("' is not a collaborator on project '");
  const skippedViewTransition = isSkippedViewTransition(reason, message);
  const injectedMetaMaskFailure =
    message === "failed to connect to metamask" &&
    /(?:chrome|moz)-extension:\/\//i.test(rejectionStack(reason));
  return (
    rootfsUnavailable ||
    routingUnavailable ||
    conatInfoBootstrapTimeout ||
    socketIoTransportClosed ||
    conatTransportClosed ||
    conatSocketRequestTimedOut ||
    conatRequestTimedOut ||
    filesystemServerStarting ||
    staleCollaboratorAccess ||
    skippedViewTransition ||
    injectedMetaMaskFailure
  );
}

export function isOpaqueCrossOriginScriptError({
  message,
  error,
  filename,
  lineNumber,
}: {
  message: unknown;
  error: unknown;
  filename: unknown;
  lineNumber: unknown;
}): boolean {
  return (
    message === "Script error." &&
    error == null &&
    !filename &&
    (lineNumber == null || lineNumber === 0)
  );
}
