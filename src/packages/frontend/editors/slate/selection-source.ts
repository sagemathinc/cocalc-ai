const sources = new WeakMap<HTMLElement, (range: Range) => string>();

export function registerMarkdownSelection(
  root: HTMLElement,
  serialize: (range: Range) => string,
): () => void {
  sources.set(root, serialize);
  return () => {
    sources.delete(root);
  };
}

export function selectedMarkdown(range: Range): string {
  let element =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  while (element) {
    const serialize = sources.get(element);
    if (serialize) return serialize(range);
    element = element.parentElement;
  }
  throw Error(
    "This selection cannot yet be quoted with its formatting intact.",
  );
}
