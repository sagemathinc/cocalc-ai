import {
  handleFileDownload,
  DOWNLOAD_ERROR_HEADER,
  fileETag,
  ifRangeMatches,
  isNotModified,
} from "./file-download";
import { EventEmitter } from "node:events";

const mockReadFile = jest.fn();
const mockFsStat = jest.fn();
const mockFsRm = jest.fn();
const mockFsClient = jest.fn(() => ({
  stat: mockFsStat,
  rm: mockFsRm,
}));
const mockFsSubject = jest.fn(() => "fs.project-test");

jest.mock("./read", () => ({
  readFile: (...args) => mockReadFile(...args),
}));

jest.mock("./fs", () => ({
  fsClient: (...args) => mockFsClient(...args),
  fsSubject: (...args) => mockFsSubject(...args),
}));

describe("handleFileDownload", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockFsStat.mockReset();
    mockFsRm.mockReset();
    mockFsClient.mockClear();
    mockFsSubject.mockClear();
  });

  it("refreshes idle timeout during a progressing long download and forwards only caller-authenticated identity", async () => {
    jest.useFakeTimers();
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      destroy: jest.fn(),
      destroyed: false,
      writableEnded: false,
      headersSent: true,
    });
    let signal!: AbortSignal;
    mockReadFile.mockImplementation(async function* (opts) {
      signal = opts.signal;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        signal.throwIfAborted();
        yield Buffer.alloc(1);
      }
    });
    try {
      const download = handleFileDownload({
        req: { method: "GET", url: "/project-test/files/a" },
        res,
        maxWait: 80,
        account_id: "authenticated-account",
        client: {} as any,
      });
      await jest.advanceTimersByTimeAsync(1000);
      await download;
      expect(res.write).toHaveBeenCalledTimes(20);
      expect(res.destroy).not.toHaveBeenCalled();
      expect(res.end).toHaveBeenCalledWith();
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.objectContaining({ account_id: "authenticated-account" }),
      );
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses stat instead of streaming for allowed HEAD downloads", async () => {
    mockFsStat.mockResolvedValue({
      size: 123,
      mtime: new Date("2026-04-26T21:00:00.000Z"),
    });
    const req: any = {
      method: "HEAD",
      url: "/project-123/files/home/user/a.tar?download",
    };
    const headers: Record<string, any> = {};
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockFsSubject).toHaveBeenCalledWith({ project_id: "project-123" });
    expect(mockFsClient).toHaveBeenCalledWith({
      client: { id: "client-1" },
      subject: "fs.project-test",
    });
    expect(mockFsStat).toHaveBeenCalledWith("/home/user/a.tar");
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(headers["Content-Length"]).toBe(123);
    expect(headers["Last-Modified"]).toBe("Sun, 26 Apr 2026 21:00:00 GMT");
    expect(res.end).toHaveBeenCalled();
  });

  it("parses legacy /projects project file URLs for HEAD downloads", async () => {
    mockFsStat.mockResolvedValue({ size: 123 });
    const req: any = {
      method: "HEAD",
      url: "/projects/project-123/files/home/user/a.tar?download",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockFsSubject).toHaveBeenCalledWith({ project_id: "project-123" });
    expect(mockFsStat).toHaveBeenCalledWith("/home/user/a.tar");
    expect(res.statusCode).toBe(200);
  });

  it("uses an explicit stat subject for HEAD downloads", async () => {
    mockFsStat.mockResolvedValue({ size: 456 });
    const req: any = {
      method: "HEAD",
      url: "/projects/project-123/files/home/user/public.txt?download&viewer=1",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      statSubject:
        "fs-share.project-project-123.share-share-id.account-user-id",
    });

    expect(mockFsSubject).not.toHaveBeenCalled();
    expect(mockFsClient).toHaveBeenCalledWith({
      client: { id: "client-1" },
      subject: "fs-share.project-project-123.share-share-id.account-user-id",
    });
    expect(mockFsStat).toHaveBeenCalledWith("/home/user/public.txt");
    expect(res.statusCode).toBe(200);
  });

  it("parses legacy /projects project file URLs for streamed downloads", async () => {
    mockReadFile.mockResolvedValue([
      Buffer.from("hello"),
      Buffer.from(" world"),
    ]);
    const req: any = {
      method: "GET",
      url: "/projects/project-123/files/home/user/a.txt?download",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockReadFile).toHaveBeenCalledWith({
      client: { id: "client-1" },
      project_id: "project-123",
      path: "/home/user/a.txt",
      maxWait: 1000 * 60 * 60,
      signal: expect.any(AbortSignal),
    });
    expect(res.write).toHaveBeenCalledWith(Buffer.from("hello"));
    expect(res.write).toHaveBeenCalledWith(Buffer.from(" world"));
    expect(res.end).toHaveBeenCalled();
  });

  it("uses an explicit read service name for streamed downloads", async () => {
    mockReadFile.mockResolvedValue([Buffer.from("hello")]);
    const req: any = {
      method: "GET",
      url: "/project-123/files/home/user/a.txt?download",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      readServiceName: ":project-host",
    });

    expect(mockReadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-123",
        path: "/home/user/a.txt",
        name: ":project-host",
      }),
    );
  });

  it("serves a satisfiable byte range through the read service", async () => {
    mockFsStat.mockResolvedValue({
      size: 100,
      mtime: new Date("2026-04-26T21:00:00.000Z"),
    });
    mockReadFile.mockResolvedValue([Buffer.from("range")]);
    const headers: Record<string, any> = {};
    const req: any = {
      method: "GET",
      url: "/project-123/files/home/user/a.pdf",
      headers: { range: "bytes=10-19" },
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      readServiceName: ":workspace",
      statSubject: "fs.project-test",
    });

    expect(res.statusCode).toBe(206);
    expect(headers["Accept-Ranges"]).toBe("bytes");
    expect(headers["Content-Range"]).toBe("bytes 10-19/100");
    expect(headers["Content-Length"]).toBe(10);
    expect(mockReadFile).toHaveBeenCalledWith({
      client: { id: "client-1" },
      project_id: "project-123",
      path: "/home/user/a.pdf",
      name: ":workspace",
      maxWait: 1000 * 60 * 60,
      signal: expect.any(AbortSignal),
      start: 10,
      end: 19,
    });
  });

  it("rejects an unsatisfiable byte range without opening a stream", async () => {
    mockFsStat.mockResolvedValue({ size: 100 });
    const headers: Record<string, any> = {};
    const req: any = {
      method: "GET",
      url: "/project-123/files/home/user/a.pdf",
      headers: { range: "bytes=100-110" },
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(res.statusCode).toBe(416);
    expect(headers["Content-Range"]).toBe("bytes */100");
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it.each(["ENOENT", "ENOTDIR"])(
    "returns 404 when a streamed file fails with %s before sending data",
    async (code) => {
      mockReadFile.mockRejectedValue(
        Object.assign(new Error("missing file"), { code }),
      );
      const req: any = {
        method: "GET",
        url: "/project-123/files/home/user/missing.pdf",
      };
      const res: any = {
        statusCode: undefined,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        writableEnded: false,
        destroyed: false,
      };

      await handleFileDownload({
        req,
        res,
        client: { id: "client-1" } as any,
      });

      expect(res.statusCode).toBe(404);
      expect(res.end).toHaveBeenCalledWith("File not found.");
      expect(res.destroy).not.toHaveBeenCalled();
    },
  );

  it("uses the requested display filename and removes temporary archives after streaming", async () => {
    mockReadFile.mockResolvedValue([Buffer.from("archive")]);
    mockFsRm.mockResolvedValue(undefined);
    const headers: Record<string, any> = {};
    const req: any = {
      method: "GET",
      url: "/project-123/files/tmp/.cocalc-download-archive-token-selection.zip?download&deleteAfterDownload=1&downloadFilename=selection.zip",
    };
    let onFinish: (() => Promise<void>) | undefined;
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      once: jest.fn((event, callback) => {
        if (event === "finish") {
          onFinish = callback;
        }
      }),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(headers["Content-disposition"]).toBe(
      "attachment; filename*=UTF-8''selection.zip",
    );
    expect(mockReadFile).toHaveBeenCalledWith({
      client: { id: "client-1" },
      project_id: "project-123",
      path: "/tmp/.cocalc-download-archive-token-selection.zip",
      maxWait: 1000 * 60 * 60,
      signal: expect.any(AbortSignal),
    });
    expect(mockFsRm).not.toHaveBeenCalled();
    expect(onFinish).toBeDefined();
    await onFinish?.();
    expect(mockFsRm).toHaveBeenCalledWith(
      "/tmp/.cocalc-download-archive-token-selection.zip",
      { force: true },
    );
  });

  it("keeps a temporary archive when the browser interrupts the download", async () => {
    async function* interruptedDownload() {
      yield Buffer.from("first chunk");
      yield Buffer.from("second chunk");
    }
    mockReadFile.mockResolvedValue(interruptedDownload());
    const req: any = {
      method: "GET",
      url: "/project-123/files/tmp/.cocalc-download-archive-token-selection.zip?download&deleteAfterDownload=1&downloadFilename=selection.zip",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      write: jest.fn(() => {
        res.destroyed = true;
        return true;
      }),
      end: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.once).not.toHaveBeenCalledWith("finish", expect.any(Function));
    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it("ignores delete-after-download for non-temporary paths", async () => {
    mockReadFile.mockResolvedValue([Buffer.from("data")]);
    const req: any = {
      method: "GET",
      url: "/project-123/files/home/user/a.txt?download&deleteAfterDownload=1",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it("removes temporary archives when a GET download is rejected before streaming", async () => {
    mockFsRm.mockResolvedValue(undefined);
    const req: any = {
      method: "GET",
      url: "/project-123/files/tmp/.cocalc-download-archive-token-selection.zip?download&deleteAfterDownload=1&downloadFilename=selection.zip",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      beforeExplicitDownload: async () => ({
        allowed: false,
        message: "managed egress blocked",
      }),
    });

    expect(res.statusCode).toBe(429);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockFsRm).toHaveBeenCalledWith(
      "/tmp/.cocalc-download-archive-token-selection.zip",
      { force: true },
    );
  });

  it("returns the managed download error for blocked HEAD preflight", async () => {
    const req: any = {
      method: "HEAD",
      url: "/project-123/files/home/user/a.tar?download",
    };
    const headers: Record<string, any> = {};
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      beforeExplicitDownload: async () => ({
        allowed: false,
        message: "managed egress blocked",
      }),
    });

    expect(res.statusCode).toBe(429);
    expect(headers[DOWNLOAD_ERROR_HEADER]).toBe(
      encodeURIComponent("managed egress blocked"),
    );
    expect(mockFsStat).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  describe("conditional (revalidated) responses", () => {
    const mtime = new Date("2026-10-19T03:00:00.250Z");
    const etag = fileETag({ size: 1234, mtime });

    function fakeRes() {
      const headers: Record<string, any> = {};
      const res: any = Object.assign(new EventEmitter(), {
        statusCode: undefined,
        headers,
        setHeader: jest.fn((key, value) => {
          headers[key] = value;
        }),
        removeHeader: jest.fn((key) => {
          delete headers[key];
        }),
        write: jest.fn(() => true),
        end: jest.fn(),
        destroy: jest.fn(),
        destroyed: false,
        writableEnded: false,
      });
      return res;
    }

    async function get(
      url: string,
      reqHeaders: Record<string, string> = {},
      conditional = true,
    ) {
      mockFsStat.mockResolvedValue({ size: 1234, mtime });
      mockReadFile.mockImplementation(async function* () {
        yield Buffer.from("png");
      });
      const res = fakeRes();
      await handleFileDownload({
        req: { method: "GET", url, headers: reqHeaders },
        res,
        client: {} as any,
        conditional,
      });
      return res;
    }

    it("sends validators and a no-cache policy, then 304 for an unchanged file", async () => {
      const first = await get("/project-1/files/home/user/a.png");
      expect(first.headers.ETag).toBe(etag);
      expect(first.headers["Cache-Control"]).toBe("private, no-cache");
      expect(first.headers["Last-Modified"]).toBe(mtime.toUTCString());
      expect(first.write).toHaveBeenCalled();

      mockReadFile.mockClear();
      const again = await get("/project-1/files/home/user/a.png", {
        "if-none-match": etag,
      });
      expect(again.statusCode).toBe(304);
      expect(again.headers["Content-Length"]).toBeUndefined();
      expect(again.write).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("sends the file again once it changes", async () => {
      const res = await get("/project-1/files/home/user/a.png", {
        "if-none-match": fileETag({ size: 1234, mtime: new Date(mtime.valueOf() - 1) }),
      });
      expect(res.statusCode).not.toBe(304);
      expect(res.write).toHaveBeenCalled();
    });

    it("never caches explicit downloads, and is off unless asked for", async () => {
      const download = await get("/project-1/files/home/user/a.png?download", {
        "if-none-match": etag,
      });
      expect(download.statusCode).not.toBe(304);
      expect(download.headers["Cache-Control"]).toBe("private, no-store");
      expect(download.headers.ETag).toBeUndefined();

      mockFsStat.mockClear();
      const plain = await get(
        "/project-1/files/home/user/a.png",
        { "if-none-match": etag },
        false,
      );
      expect(plain.statusCode).not.toBe(304);
      expect(plain.headers.ETag).toBeUndefined();
      expect(mockFsStat).not.toHaveBeenCalled();
    });

    it("honors If-Range: a stale validator gets the whole file, a current date gets the range", async () => {
      const stale = await get("/project-1/files/home/user/a.png", {
        range: "bytes=0-1",
        "if-range": etag,
      });
      expect(stale.statusCode).not.toBe(206);
      expect(stale.headers["Content-Length"]).toBe(1234);
      const oldDate = await get("/project-1/files/home/user/a.png", {
        range: "bytes=0-1",
        "if-range": "Mon, 19 Oct 2026 02:00:00 GMT",
      });
      expect(oldDate.statusCode).not.toBe(206);
      const current = await get("/project-1/files/home/user/a.png", {
        range: "bytes=0-1",
        "if-range": mtime.toUTCString(),
      });
      expect(current.statusCode).toBe(206);
    });

    it("serves ranges in full rather than answering 304", async () => {
      const res = await get("/project-1/files/home/user/a.png", {
        "if-none-match": etag,
        range: "bytes=0-1",
      });
      expect(res.statusCode).toBe(206);
    });
  });
});

describe("ifRangeMatches", () => {
  const mtime = new Date("2026-10-19T03:00:00.250Z");
  const headers = { "if-range": mtime.toUTCString() };

  it("trusts a matching date only once it is at least a second old", () => {
    expect(ifRangeMatches({ headers, mtime, now: mtime.valueOf() + 1000 })).toBe(true);
    expect(ifRangeMatches({ headers, mtime, now: mtime.valueOf() + 999 })).toBe(false);
    expect(ifRangeMatches({ headers: {}, mtime, now: mtime.valueOf() })).toBe(true);
  });
});

describe("isNotModified", () => {
  const mtime = new Date("2026-10-19T03:00:00.250Z");
  const etag = fileETag({ size: 1, mtime });

  it("compares entity tags weakly, in lists and with *", () => {
    expect(isNotModified({ headers: { "if-none-match": etag }, etag, mtime })).toBe(true);
    expect(
      isNotModified({ headers: { "if-none-match": etag.slice(2) }, etag, mtime }),
    ).toBe(true);
    expect(
      isNotModified({ headers: { "if-none-match": `W/"x", ${etag}` }, etag, mtime }),
    ).toBe(true);
    expect(isNotModified({ headers: { "if-none-match": "*" }, etag, mtime })).toBe(true);
    expect(isNotModified({ headers: { "if-none-match": 'W/"x"' }, etag, mtime })).toBe(false);
  });

  it("falls back to If-Modified-Since at one-second resolution", () => {
    const at = (iso: string) =>
      isNotModified({ headers: { "if-modified-since": iso }, etag, mtime });
    expect(at(mtime.toUTCString())).toBe(true);
    expect(at("Mon, 19 Oct 2026 02:59:59 GMT")).toBe(false);
    expect(at("not a date")).toBe(false);
    // If-None-Match wins when both are present.
    expect(
      isNotModified({
        headers: { "if-none-match": 'W/"x"', "if-modified-since": mtime.toUTCString() },
        etag,
        mtime,
      }),
    ).toBe(false);
    expect(isNotModified({ headers: {}, etag, mtime })).toBe(false);
  });
});
