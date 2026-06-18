import {
  isProjectRecentlyCreated,
  markProjectRecentlyCreated,
  RECENT_PROJECT_WINDOW_MS,
} from "./recently-created-project";

describe("recently created project marker", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("recognizes projects marked in this browser session", () => {
    jest.spyOn(Date, "now").mockReturnValue(100_000);
    markProjectRecentlyCreated("project-1");

    expect(
      isProjectRecentlyCreated({
        project_id: "project-1",
        nowMs: 100_000 + RECENT_PROJECT_WINDOW_MS - 1,
      }),
    ).toBe(true);
    expect(
      isProjectRecentlyCreated({
        project_id: "project-1",
        nowMs: 100_000 + RECENT_PROJECT_WINDOW_MS + 1,
      }),
    ).toBe(false);
  });

  it("recognizes recent project metadata without a local marker", () => {
    expect(
      isProjectRecentlyCreated({
        project_id: "project-2",
        created: "2026-06-12T12:00:00.000Z",
        nowMs: Date.parse("2026-06-12T12:09:00.000Z"),
      }),
    ).toBe(true);
    expect(
      isProjectRecentlyCreated({
        project_id: "project-2",
        created: "2026-06-12T12:00:00.000Z",
        nowMs: Date.parse("2026-06-12T12:11:00.000Z"),
      }),
    ).toBe(false);
  });
});
