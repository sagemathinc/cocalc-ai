import { wrapDocsPrintHtml } from "./download-html";

test("standalone docs include independent native themes and accessible controls", () => {
  const html = wrapDocsPrintHtml("<main><h1>Documentation</h1></main>", {
    includeResourceLinks: false,
  });
  const doc = new DOMParser().parseFromString(html, "text/html");
  expect(doc.querySelector("main h1")?.textContent).toBe("Documentation");
  expect(doc.querySelector("label select")?.id).toBe("cocalc-docs-appearance");
  expect(
    Array.from(doc.querySelectorAll("select option")).map((option) =>
      option.getAttribute("value"),
    ),
  ).toEqual(["system", "light", "dark"]);
  expect(html).toContain("--cocalc-ui-text");
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).toContain("@media print");
  expect(html).not.toContain("darkreader");
  expect(doc.querySelector("script[src]")).toBeNull();
});
