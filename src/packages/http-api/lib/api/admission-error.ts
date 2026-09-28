import type { ServerResponse } from "http";
import { serviceErrorAttributes } from "@cocalc/conat/util";

// Translate only known admission denials; leave unrelated legacy errors alone.
export function sendAdmissionError(
  res: Pick<ServerResponse, "setHeader" | "statusCode"> & {
    json: (body: object) => unknown;
  },
  err: unknown,
): boolean {
  const { code, retry_after_ms } = serviceErrorAttributes(err);
  if (code !== "api_search_rate_limited") return false;
  res.statusCode = 429;
  res.setHeader("Cache-Control", "no-store");
  if (retry_after_ms !== undefined) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil(retry_after_ms / 1000))),
    );
  }
  res.json({
    error: "API search rate limit exceeded",
    code,
    ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
  });
  return true;
}
