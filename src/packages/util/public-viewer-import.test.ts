import {
  extractProjectIdFromPublicViewerRawUrl,
  parsePublicViewerImportUrl,
} from "./public-viewer-import";

describe("parsePublicViewerImportUrl", () => {
  it("extracts the raw source from a public viewer page URL", () => {
    expect(
      parsePublicViewerImportUrl(
        "https://dev-raw.example.com/static/public-viewer-ipynb.html?source=https%3A%2F%2Fhost-1-dev.example.com%2Fp%2Fapps%2Fdemo%2Fa.ipynb%3Fraw%3D1&path=%2Fa.ipynb&title=a.ipynb",
      ),
    ).toEqual({
      importUrl:
        "https://dev-raw.example.com/static/public-viewer-ipynb.html?source=https%3A%2F%2Fhost-1-dev.example.com%2Fp%2Fapps%2Fdemo%2Fa.ipynb%3Fraw%3D1&path=%2Fa.ipynb&title=a.ipynb",
      rawUrl: "https://host-1-dev.example.com/p/apps/demo/a.ipynb?raw=1",
      path: "/a.ipynb",
      title: "a.ipynb",
    });
  });

  it("falls back to the URL path for direct raw URLs", () => {
    expect(
      parsePublicViewerImportUrl(
        "https://host-1-dev.example.com/p/apps/demo/a.md?raw=1",
      ),
    ).toEqual({
      importUrl: "https://host-1-dev.example.com/p/apps/demo/a.md?raw=1",
      rawUrl: "https://host-1-dev.example.com/p/apps/demo/a.md?raw=1",
      path: "/p/apps/demo/a.md",
      title: undefined,
    });
  });

  it("extracts the source project id from launchpad-style raw app URLs", () => {
    expect(
      extractProjectIdFromPublicViewerRawUrl(
        "https://host-1-dev.example.com/00000000-1000-4000-8000-000000000000/apps/demo/a.ipynb?raw=1",
      ),
    ).toBe("00000000-1000-4000-8000-000000000000");
  });
});
