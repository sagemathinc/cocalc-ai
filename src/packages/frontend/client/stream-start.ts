export function resolveExplicitStreamStart(
  optionValue: boolean | undefined,
  legacyValue: boolean,
): boolean {
  return optionValue ?? legacyValue;
}
