// This phrase is a wire-format contract between backend auth errors and
// frontend routed project-host backoff parsing. Keep it stable and use the
// helpers below instead of ad-hoc string changes.
export const AUTH_RETRY_IN_ABOUT_PHRASE = "retry in about";

export function formatRetryInAbout(waitSec: number): string {
  const seconds = Math.max(1, Math.ceil(waitSec));
  return `${AUTH_RETRY_IN_ABOUT_PHRASE} ${seconds}s`;
}

export function parseRetryInAboutSeconds(message: string): number | undefined {
  const match = message.match(/retry in about\s+(\d+)\s*s\b/i);
  if (!match) return;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  return seconds;
}
