import { handleFileDownload, DOWNLOAD_ERROR_HEADER } from "./file-download";

const mockReadFile = jest.fn();
const mockFsStat = jest.fn();
const mockFsClient = jest.fn(() => ({
  stat: mockFsStat,
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
    mockFsClient.mockClear();
    mockFsSubject.mockClear();
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
});
