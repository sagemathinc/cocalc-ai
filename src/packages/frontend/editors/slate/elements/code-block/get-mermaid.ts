let initialized = false;
export default async function getMermaid(): Promise<any> {
  const mermaid = (await import("mermaid")).default;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      // Diagram text comes from documents other people can edit, and the
      // rendered SVG is inserted with innerHTML. "strict" makes mermaid
      // sanitize labels and disables click handlers. It is mermaid's default,
      // but set it explicitly so a config change can't loosen it, and keep it
      // among the keys a diagram's %%{init}%% directive cannot override.
      securityLevel: "strict",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
      ],
    });
    initialized = true;
  }
  return mermaid;
}
