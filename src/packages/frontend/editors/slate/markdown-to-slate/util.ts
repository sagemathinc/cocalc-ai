export function parseFragmentElement(content: string): Element | null {
  if (typeof document === "undefined") {
    return null;
  }
  const template = document.createElement("template");
  template.innerHTML = content.trim();
  return template.content.firstElementChild;
}

export function getAttrs(content: string, attrs: string[]): [string, string][] {
  const element = parseFragmentElement(content);
  const v: [string, string][] = [];
  for (const attr of attrs) {
    const val = element?.getAttribute(attr);
    if (val != null) {
      v.push([attr, val]);
    }
  }
  return v;
}
