export function isMissingRusticRepositoryError(err: unknown): boolean {
  const text = `${err ?? ""}`;
  return text.includes("No repository config file found");
}
