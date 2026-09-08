import { isPublicBlobAvailable } from "./public-url";

describe("legacy blob redirect availability", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [200, "image/png", true],
    [404, "text/plain", false],
    [403, "text/html", false],
    [200, "text/html", false],
  ])("handles status %s with %s", async (status, contentType, expected) => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      status,
      headers: new Headers({ "content-type": contentType }),
    } as Response);
    expect(await isPublicBlobAvailable("https://blobs.example.edu/id")).toBe(
      expected,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://blobs.example.edu/id",
      expect.objectContaining({ method: "HEAD", redirect: "error" }),
    );
  });

  it("preserves the hub fallback when the Worker cannot be reached", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    expect(await isPublicBlobAvailable("https://blobs.example.edu/id")).toBe(
      false,
    );
  });
});
