type SlateOperationLike = { type: string };

export function hasOnlySelectionOperations(
  operations: readonly SlateOperationLike[],
): boolean {
  return (
    operations.length > 0 &&
    operations.every((operation) => operation.type === "set_selection")
  );
}

export function isLocalContentChange({
  operations,
  syncCausedUpdate,
}: {
  operations: readonly SlateOperationLike[];
  syncCausedUpdate: boolean;
}): boolean {
  return !syncCausedUpdate && !hasOnlySelectionOperations(operations);
}

// Whether onChange reports the tree an external value left the editor in,
// with no operation since: then the change is the external one, even if it is
// delivered after the editor's sync-caused flag was cleared (React may deliver
// onChange a render later). A local edit always adds an operation of its own.
export function isExternalTreeChange({
  value,
  operations,
  externalValue,
  externalOperations,
}: {
  value: unknown;
  operations: readonly unknown[];
  externalValue: unknown;
  externalOperations: ReadonlySet<unknown>;
}): boolean {
  return (
    value != null &&
    value === externalValue &&
    operations.every((operation) => externalOperations.has(operation))
  );
}
