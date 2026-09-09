import {
  isPublicBlobAvailable,
  PUBLIC_BLOB_MAX_CONCURRENT_PROBES,
  resetPublicBlobAvailabilityForTests,
} from "./public-url";

describe("legacy blob redirect availability", () => {
  afterEach(() => {
    resetPublicBlobAvailabilityForTests();
    jest.restoreAllMocks();
  });

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

  it("caches availability and coalesces concurrent probes", async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = jest.spyOn(global, "fetch").mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const first = isPublicBlobAvailable("https://blobs.example.edu/id");
    const second = isPublicBlobAvailable("https://blobs.example.edu/id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(
      new Response(undefined, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(
      isPublicBlobAvailable("https://blobs.example.edu/id"),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds probes for public random UUID traffic", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    const requests = Array.from(
      { length: PUBLIC_BLOB_MAX_CONCURRENT_PROBES + 20 },
      (_, index) => isPublicBlobAvailable(`https://blobs.example.edu/${index}`),
    );
    await expect(
      Promise.all(requests.slice(PUBLIC_BLOB_MAX_CONCURRENT_PROBES)),
    ).resolves.toEqual(Array(20).fill(false));
    expect(fetchMock).toHaveBeenCalledTimes(PUBLIC_BLOB_MAX_CONCURRENT_PROBES);
    for (const resolve of pending) {
      resolve(
        new Response(undefined, {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
      );
    }
    await expect(
      Promise.all(requests.slice(0, PUBLIC_BLOB_MAX_CONCURRENT_PROBES)),
    ).resolves.toEqual(Array(PUBLIC_BLOB_MAX_CONCURRENT_PROBES).fill(false));
  });

  it("refuses non-HTTPS probe targets", async () => {
    const fetchMock = jest.spyOn(global, "fetch");
    await expect(
      isPublicBlobAvailable("http://localhost/internal"),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
