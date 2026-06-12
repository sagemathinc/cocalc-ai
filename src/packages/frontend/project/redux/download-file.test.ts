import { downloadProjectFile } from "./download-file";
import { download_href, url_href } from "@cocalc/frontend/project/utils";

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

describe("downloadProjectFile", () => {
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(1781039539671);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it("downloads through the project-host file route without requiring project start", async () => {
    const logAction = jest.fn();
    const routeProjectHostHttpUrl = jest
      .fn()
      .mockResolvedValue("https://host.example/download");
    const ensureProjectHostBrowserSessionForProject = jest.fn();
    const downloadFile = jest.fn().mockResolvedValue(undefined);

    await downloadProjectFile({
      project_id: "project-1",
      path: "/home/user/data.tar.gz",
      log: true,
      logAction,
      routeProjectHostHttpUrl,
      ensureProjectHostBrowserSessionForProject,
      downloadFile,
      openNewTab: jest.fn(),
    });

    const hubUrl = download_href("project-1", "/home/user/data.tar.gz");
    expect(routeProjectHostHttpUrl).toHaveBeenCalledWith({
      project_id: "project-1",
      url: hubUrl,
    });
    expect(downloadFile).toHaveBeenCalledWith("https://host.example/download", {
      onAuthFailure: expect.any(Function),
    });
    expect(logAction).toHaveBeenCalledWith({
      event: "file_action",
      action: "downloaded",
      files: ["/home/user/data.tar.gz"],
    });
  });

  it("refreshes project-host browser auth and reroutes on auth failure", async () => {
    const routeProjectHostHttpUrl = jest
      .fn()
      .mockResolvedValueOnce("https://host.example/old")
      .mockResolvedValueOnce("https://host.example/new");
    const ensureProjectHostBrowserSessionForProject = jest
      .fn()
      .mockResolvedValue(undefined);
    const downloadFile = jest.fn(async (_url, opts) => {
      await opts.onAuthFailure();
    });

    await downloadProjectFile({
      project_id: "project-1",
      path: "/home/user/data.tar.gz",
      routeProjectHostHttpUrl,
      ensureProjectHostBrowserSessionForProject,
      downloadFile,
      logAction: jest.fn(),
      openNewTab: jest.fn(),
    });

    const hubUrl = download_href("project-1", "/home/user/data.tar.gz");
    expect(ensureProjectHostBrowserSessionForProject).toHaveBeenCalledWith({
      project_id: "project-1",
    });
    expect(routeProjectHostHttpUrl.mock.calls).toEqual([
      [{ project_id: "project-1", url: hubUrl }],
      [{ project_id: "project-1", url: hubUrl }],
    ]);
  });

  it("routes temporary archive downloads with server-side cleanup and a display filename", async () => {
    const routeProjectHostHttpUrl = jest
      .fn()
      .mockResolvedValue("https://host.example/download");
    const downloadFile = jest.fn().mockResolvedValue(undefined);

    await downloadProjectFile({
      project_id: "project-1",
      path: "/tmp/.cocalc-download-archive-temp-selection.zip",
      deleteAfterDownload: true,
      downloadFilename: "selection.zip",
      routeProjectHostHttpUrl,
      ensureProjectHostBrowserSessionForProject: jest.fn(),
      downloadFile,
      logAction: jest.fn(),
      openNewTab: jest.fn(),
    });

    const hubUrl = download_href(
      "project-1",
      "/tmp/.cocalc-download-archive-temp-selection.zip",
      {
        deleteAfterDownload: true,
        downloadFilename: "selection.zip",
      },
    );
    expect(routeProjectHostHttpUrl).toHaveBeenCalledWith({
      project_id: "project-1",
      url: hubUrl,
    });
    expect(hubUrl).toContain("deleteAfterDownload=1");
    expect(hubUrl).toContain("downloadFilename=selection.zip");
    expect(downloadFile).toHaveBeenCalledWith("https://host.example/download", {
      onAuthFailure: expect.any(Function),
    });
  });

  it("uses a direct file URL for print/manual open mode", async () => {
    const print = jest.fn();
    const openNewTab = jest.fn(() => ({ print }) as any);

    await downloadProjectFile({
      project_id: "project-1",
      path: "/home/user/plot.pdf",
      auto: false,
      print: true,
      logAction: jest.fn(),
      routeProjectHostHttpUrl: jest.fn(),
      ensureProjectHostBrowserSessionForProject: jest.fn(),
      downloadFile: jest.fn(),
      openNewTab,
    });

    expect(openNewTab).toHaveBeenCalledWith(
      url_href("project-1", "/home/user/plot.pdf"),
    );
    expect(print).toHaveBeenCalled();
  });
});
