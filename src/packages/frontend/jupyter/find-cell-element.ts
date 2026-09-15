// Cell ids (including heading anchors from imported notebooks) are opaque text,
// not CSS selectors. Scope the lookup to this frame: split views share ids.
export function findCellElement(
  container: HTMLElement | null | undefined,
  id: string | undefined,
): HTMLElement | undefined {
  if (container == null || id == null) return;
  return Array.from(container.querySelectorAll<HTMLElement>("[id]")).find(
    (element) => element.id === id,
  );
}
