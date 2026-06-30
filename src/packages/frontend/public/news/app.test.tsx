import { newsExcerpt } from "./app";

describe("newsExcerpt", () => {
  it("preserves technical characters while removing markdown syntax", () => {
    expect(
      newsExcerpt(
        [
          "## Release notes",
          "",
          "Use `COCALC_API_URL`, edit `__init__.py`, and choose C#.",
          "",
          "[Docs](https://doc.cocalc.com) and **important** text.",
        ].join("\n"),
      ),
    ).toBe(
      "Release notes Use COCALC_API_URL, edit __init__.py, and choose C#. Docs and important text.",
    );
  });
});
