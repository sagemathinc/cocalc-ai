import { appOutputText } from "./app-output-text";

describe("appOutputText", () => {
  const text = "Usage: cocalc project [options]\n  help [command]\n";

  it("decodes bytes received over conat", () => {
    expect(appOutputText(new TextEncoder().encode(text))).toBe(text);
  });

  it("decodes a Buffer", () => {
    expect(appOutputText(Buffer.from(text))).toBe(text);
  });

  it("decodes a JSON-encoded Buffer", () => {
    expect(appOutputText(JSON.parse(JSON.stringify(Buffer.from(text))))).toBe(
      text,
    );
  });

  it("decodes an ArrayBuffer", () => {
    const bytes = new TextEncoder().encode(text);
    expect(appOutputText(bytes.buffer)).toBe(text);
  });

  it("decodes UTF-8", () => {
    expect(appOutputText(new TextEncoder().encode("Größe ✓"))).toBe("Größe ✓");
  });

  it("passes strings through and treats missing output as empty", () => {
    expect(appOutputText(text)).toBe(text);
    expect(appOutputText(undefined)).toBe("");
    expect(appOutputText(null)).toBe("");
  });
});
