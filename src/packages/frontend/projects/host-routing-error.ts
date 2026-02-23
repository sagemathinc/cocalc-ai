export function isHostRoutingUnavailableError(error: unknown): boolean {
  const s = `${(error as any)?.message ?? (error as any)?.error ?? error ?? ""}`
    .toLowerCase()
    .trim();
  if (!s) return false;
  return (
    s.includes("no subscribers matching") ||
    s.includes("unable to route") ||
    s.includes("project actions unavailable")
  );
}

