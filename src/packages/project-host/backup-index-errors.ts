export function isMissingRusticRepositoryError(err: unknown): boolean {
  const text = `${err ?? ""}`;
  return (
    text.includes("No repository config file found") ||
    (text.includes("path=config") &&
      text.includes("stat failed NotFound") &&
      text.includes("rustic_core") &&
      text.includes("the configuration"))
  );
}
