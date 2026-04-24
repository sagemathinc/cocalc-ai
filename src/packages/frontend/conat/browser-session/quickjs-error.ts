export type BrowserQuickJSErrorDetails = {
  name?: string;
  message?: string;
  stack?: string;
  value?: unknown;
};

function stringifyDetails(details: BrowserQuickJSErrorDetails): string {
  try {
    return JSON.stringify(details);
  } catch {
    return JSON.stringify({
      value: Object.prototype.toString.call(details.value),
    });
  }
}

export function normalizeQuickJSErrorDump(
  dumped: unknown,
): BrowserQuickJSErrorDetails {
  if (dumped == null) {
    return { value: dumped };
  }
  if (typeof dumped === "string") {
    return { message: dumped };
  }
  if (typeof dumped !== "object") {
    return { value: dumped };
  }
  const row = dumped as Record<string, unknown>;
  const details: BrowserQuickJSErrorDetails = {};
  if (typeof row.name === "string" && row.name.trim()) {
    details.name = row.name;
  }
  if (typeof row.message === "string" && row.message.trim()) {
    details.message = row.message;
  }
  if (typeof row.stack === "string" && row.stack.trim()) {
    details.stack = row.stack;
  }
  if (!details.name && !details.message && !details.stack) {
    details.value = dumped;
  }
  return details;
}

export function formatQuickJSErrorDump(dumped: unknown): string {
  const details = normalizeQuickJSErrorDump(dumped);
  const summary =
    details.name && details.message
      ? `${details.name}: ${details.message}`
      : details.message
        ? details.message
        : details.name
          ? details.name
          : typeof details.value === "string"
            ? details.value
            : Object.prototype.toString.call(details.value);
  return `${summary}; details=${stringifyDetails(details)}`;
}
