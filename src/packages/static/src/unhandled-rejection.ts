// Safari error stacks contain frames but often omit the error name/message.
// Keep those fields together and report the original stack, not this handler's.
export function unhandledRejectionDetails(reason: unknown): {
  message: string;
  stack?: string;
} {
  let message: string;
  let stack: string | undefined;
  if (reason != null && typeof reason === "object") {
    const error = reason as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    stack =
      typeof error.stack === "string" && error.stack ? error.stack : undefined;
    const text = typeof error.message === "string" ? error.message : "";
    const name = typeof error.name === "string" ? error.name : "";
    const header = text ? (name ? `${name}: ${text}` : text) : "";
    if (header) {
      message = stack?.startsWith(header)
        ? stack
        : [header, stack].filter(Boolean).join("\n");
    } else if (stack) {
      message = stack;
    } else {
      try {
        message = JSON.stringify(reason)?.slice(0, 1000) ?? String(reason);
      } catch {
        message = "<unserializable rejection>";
      }
    }
  } else {
    message = reason == null ? "<no reason>" : String(reason);
  }
  return { message: `unhandledrejection: ${message}`, stack };
}
