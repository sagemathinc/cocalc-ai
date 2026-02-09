/*
 * Guard for stale editor callbacks after send.
 * When composer has just been cleared, some editor paths can emit the last sent
 * content again; this helper filters only those echoes.
 */

export type SentEchoGuard = {
  raw: string;
  trimmed: string;
  active: boolean;
} | null;

export function shouldIgnoreSentEcho({
  suppress,
  incoming,
  currentInput,
}: {
  suppress: SentEchoGuard;
  incoming: string;
  currentInput: string;
}): boolean {
  if (!suppress?.active) return false;
  const incomingTrimmed = incoming.trim();
  const sameAsSent =
    incoming === suppress.raw || incomingTrimmed === suppress.trimmed;
  return sameAsSent && currentInput.trim() === "";
}

