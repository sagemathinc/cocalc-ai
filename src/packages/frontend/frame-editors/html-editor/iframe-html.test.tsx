/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { Map as ImmutableMap } from "immutable";

const issueMock = jest.fn();
const readFileMock = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      ensureProjectHostBrowserSessionForProject: async () => {},
      hub: {
        hosts: {
          issueProjectContentUrl: (opts: any) => issueMock(opts),
        },
      },
    },
    project_client: {
      readFile: (opts: any) => readFileMock(opts),
    },
  },
}));
jest.mock("@cocalc/frontend/project/use-project-host-authed-url", () => ({
  useProjectHostAuthedUrl: ({ url }: { url?: string }) => url,
}));
jest.mock("../frame-tree/hooks", () => ({
  use_font_size_scaling: () => 1,
}));

import { CONTENT_FRAME_SANDBOX, IFrameHTML } from "./iframe-html";
import { refreshDelayMs } from "@cocalc/frontend/project/use-project-content-url";

const CONTENT_URL =
  "https://p.h-h.usercontent.example/_c/cap/files/home/user/a.html";

function renderFrame(project_id: string, mode?: "rmd") {
  const actions = { set_error: jest.fn(), set_active_id: jest.fn() };
  return render(
    <IFrameHTML
      id="f1"
      actions={actions}
      editor_state={ImmutableMap() as any}
      is_fullscreen={false}
      project_id={project_id}
      path="/home/user/a.html"
      reload={7}
      font_size={14}
      tab_is_visible
      mode={mode}
      derived_file_types={undefined as any}
      value="<p>hi</p>"
    />,
  );
}

let nextProject = 0;
function freshProject(): string {
  // The hook remembers "unavailable" per project, so each test uses its own.
  nextProject += 1;
  return `00000000-0000-4000-8000-${`${nextProject}`.padStart(12, "0")}`;
}

beforeEach(() => {
  issueMock.mockReset();
  readFileMock.mockReset();
  readFileMock.mockResolvedValue(Buffer.from("<p>hi</p>"));
});

describe("IFrameHTML on a site with a content origin", () => {
  it("shows the saved file on the content origin, sandboxed, with no Trusted switch", async () => {
    issueMock.mockResolvedValue({
      url: CONTENT_URL,
      expires_at: Date.now() + 24 * 3600 * 1000,
    });
    const project_id = freshProject();
    renderFrame(project_id);
    const frame = await waitFor(() => {
      const el = screen.getByTitle("Rendered preview of /home/user/a.html");
      expect(el.getAttribute("src")).toBe(`${CONTENT_URL}?param=7`);
      return el;
    });
    expect(issueMock).toHaveBeenCalledWith({
      project_id,
      path: "/home/user/a.html",
    });
    expect(frame.getAttribute("sandbox")).toBe(CONTENT_FRAME_SANDBOX);
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("never lets the content frame navigate the app's tab", () => {
    expect(CONTENT_FRAME_SANDBOX).not.toMatch(/allow-top-navigation/);
  });
});

describe("IFrameHTML without a content origin", () => {
  it.each([
    ["the origin is off", () => issueMock.mockResolvedValue({ unavailable: "off" })],
    ["the hub call fails", () => issueMock.mockRejectedValue(new Error("old hub"))],
  ])("falls back to the sandboxed preview and the switch when %s", async (_label, setup) => {
    setup();
    renderFrame(freshProject());
    const frame = await waitFor(() => {
      const el = screen.getByTitle("Rendered preview of /home/user/a.html");
      expect(el.getAttribute("srcdoc")).toBe("<p>hi</p>");
      return el;
    });
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-forms allow-scripts allow-presentation",
    );
    expect(frame.getAttribute("src")).toBeNull();
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("doesn't ask again for a project whose origin is off", async () => {
    issueMock.mockResolvedValue({ unavailable: "off" });
    const project_id = freshProject();
    const first = renderFrame(project_id);
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());
    first.unmount();
    await act(async () => {
      renderFrame(project_id);
    });
    expect(issueMock).toHaveBeenCalledTimes(1);
  });

  it("keeps R Markdown on the old path", async () => {
    await act(async () => {
      renderFrame(freshProject(), "rmd");
    });
    expect(issueMock).not.toHaveBeenCalled();
  });
});

describe("refreshDelayMs", () => {
  it("re-issues an hour early for a day-long link and halfway for a short one", () => {
    const now = 1_000_000_000;
    expect(refreshDelayMs(now + 24 * 3600_000, now)).toBe(23 * 3600_000);
    expect(refreshDelayMs(now + 20 * 60_000, now)).toBe(10 * 60_000);
    expect(refreshDelayMs(now - 1, now)).toBe(30_000);
  });
});
