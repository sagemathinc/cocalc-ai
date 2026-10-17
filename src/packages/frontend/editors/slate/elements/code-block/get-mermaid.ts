let initialized = false;
export default async function getMermaid(): Promise<any> {
  const mermaid = (await import("mermaid")).default;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      // Diagram text comes from documents other people can edit. The
      // rendered SVG also goes through our own policy (sanitize-mermaid-svg.ts)
      // before it is inserted; this is a first layer. "strict" makes mermaid
      // sanitize labels and disables click handlers. It is mermaid's default,
      // but set it explicitly so a config change can't loosen it, and keep it
      // among the keys a diagram's %%{init}%% directive cannot override.
      securityLevel: "strict",
      // Native SVG text labels instead of HTML in foreignObject, which the
      // output policy in sanitize-mermaid-svg.ts drops.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
      ],
    });
    initialized = true;
  }
  return mermaid;
}
