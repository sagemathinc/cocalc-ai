import {
  isPassiveInlineType,
  projectFileResponseName,
} from "./file-response-type";

describe("the name and type a project file is served with", () => {
  it("comes from the path", () => {
    expect(projectFileResponseName({ path: "/d/a.html", url: "/p/files/d/a.html" })).toEqual({
      fileName: "a.html",
      contentType: "text/html",
      download: false,
    });
  });

  it("can be renamed only for a download, which is an attachment", () => {
    // Inline, a renamed passive file would be served as HTML.
    expect(
      projectFileResponseName({
        path: "/d/a.png",
        url: "/p/files/d/a.png?downloadFilename=x.html",
      }),
    ).toMatchObject({ fileName: "a.png", contentType: "image/png", download: false });
    expect(
      projectFileResponseName({
        path: "/d/a.png",
        url: "/p/files/d/a.png?download&downloadFilename=dir/x.html",
      }),
    ).toMatchObject({ fileName: "x.html", contentType: "text/html", download: true });
  });
});

describe("passive types", () => {
  it.each([
    "image/png",
    "image/jpeg",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/json",
    "audio/mpeg",
    "video/mp4",
    "text/plain; charset=utf-8",
  ])("%s is shown inline", (type) => {
    expect(isPassiveInlineType(type)).toBe(true);
  });

  it.each([
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
    "application/xslt+xml",
    "application/mathml+xml",
    "text/javascript",
    "application/octet-stream",
    "",
  ])("%s is not", (type) => {
    expect(isPassiveInlineType(type)).toBe(false);
  });

  it("an unknown type is not", () => {
    expect(isPassiveInlineType(false)).toBe(false);
  });
});
