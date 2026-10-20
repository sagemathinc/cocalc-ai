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
const authedUrlMock = jest.fn(({ url }: { url?: string }) => url);
jest.mock("@cocalc/frontend/project/use-project-host-authed-url", () => ({
  useProjectHostAuthedUrl: (opts: { url?: string }) => authedUrlMock(opts),
}));
jest.mock("../frame-tree/hooks", () => ({
  use_font_size_scaling: () => 1,
}));

import { set_local_storage } from "@cocalc/frontend/misc/local-storage";
import { CONTENT_FRAME_SANDBOX, IFrameHTML } from "./iframe-html";
import { notifyAllContentLinksRevoked } from "@cocalc/frontend/project/content-link-revocations";
import {
  errorRetryDelayMs,
  notifyContentLinksRevoked,
  refreshDelayMs,
} from "@cocalc/frontend/project/use-project-content-url";

const CONTENT_URL =
  "https://p.h-h.usercontent.example/_c/cap/files/home/user/a.html";

function renderFrame(
  project_id: string,
  mode?: "rmd",
  path = "/home/user/a.html",
  actions = { set_error: jest.fn(), set_active_id: jest.fn() },
  reload = 7,
) {
  return render(frameElement(project_id, mode, path, actions, reload));
}

function frameElement(
  project_id: string,
  mode?: "rmd",
  path = "/home/user/a.html",
  actions = { set_error: jest.fn(), set_active_id: jest.fn() },
  reload = 7,
) {
  return (
    <IFrameHTML
      id="f1"
      actions={actions}
      editor_state={ImmutableMap() as any}
      is_fullscreen={false}
      project_id={project_id}
      path={path}
      reload={reload}
      font_size={14}
      tab_is_visible
      mode={mode}
      derived_file_types={undefined as any}
      value="<p>hi</p>"
    />
  );
}

let nextProject = 0;
function freshProject(): string {
  // The hook remembers "unavailable" per project, so each test uses its own.
  nextProject += 1;
  return `00000000-0000-4000-8000-${`${nextProject}`.padStart(12, "0")}`;
}

beforeEach(() => {
  jest.useRealTimers();
  authedUrlMock.mockClear();
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

  it("keeps the page's own origin and scripts but never lets it navigate the app's tab", () => {
    const flags = CONTENT_FRAME_SANDBOX.split(/\s+/);
    expect(flags).toEqual(
      expect.arrayContaining(["allow-scripts", "allow-same-origin"]),
    );
    expect(flags.filter((flag) => flag.startsWith("allow-top-navigation"))).toEqual([]);
  });

  it("doesn't also load a trusted host-origin URL for a file trusted before", async () => {
    const project_id = freshProject();
    set_local_storage(`${project_id}:/home/user/a.html:trust`, "true");
    issueMock.mockResolvedValue({
      url: CONTENT_URL,
      expires_at: Date.now() + 24 * 3600 * 1000,
    });
    renderFrame(project_id);
    await waitFor(() =>
      expect(
        screen.getByTitle("Rendered preview of /home/user/a.html").getAttribute("src"),
      ).toBe(`${CONTENT_URL}?param=7`),
    );
    expect(authedUrlMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.any(String) }),
    );
  });

  it("re-issues the link before it expires", async () => {
    jest.useFakeTimers();
    const second = CONTENT_URL.replace("/cap/", "/cap2/");
    issueMock
      .mockResolvedValueOnce({ url: CONTENT_URL, expires_at: Date.now() + 120_000 })
      .mockResolvedValueOnce({ url: second, expires_at: Date.now() + 24 * 3600_000 });
    renderFrame(freshProject());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    const frame = () => screen.getByTitle("Rendered preview of /home/user/a.html");
    expect(frame().getAttribute("src")).toBe(`${CONTENT_URL}?param=7`);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(61_000);
    });
    expect(issueMock).toHaveBeenCalledTimes(2);
    expect(frame().getAttribute("src")).toBe(`${second}?param=7`);
  });

  it("switches to a new link at once after \"Revoke content links\" in this browser", async () => {
    const second = CONTENT_URL.replace("/cap/", "/cap2/");
    issueMock
      .mockResolvedValueOnce({ url: CONTENT_URL, expires_at: Date.now() + 24 * 3600_000 })
      .mockResolvedValue({ url: second, expires_at: Date.now() + 24 * 3600_000 });
    const project_id = freshProject();
    renderFrame(project_id);
    const src = () =>
      screen.getByTitle("Rendered preview of /home/user/a.html").getAttribute("src");
    await waitFor(() => expect(src()).toBe(`${CONTENT_URL}?param=7`));
    await act(async () => {
      notifyContentLinksRevoked(freshProject()); // another project: nothing
    });
    expect(issueMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      notifyContentLinksRevoked(project_id);
    });
    await waitFor(() => expect(src()).toBe(`${second}?param=7`));
    expect(issueMock).toHaveBeenCalledTimes(2);
  });

  it("re-issues links in every project after a password change or 2FA setup in this browser", async () => {
    issueMock.mockImplementation(async ({ project_id }: any) => ({
      url: `${CONTENT_URL}#${project_id}-${issueMock.mock.calls.length}`,
      expires_at: Date.now() + 24 * 3600_000,
    }));
    renderFrame(freshProject());
    renderFrame(freshProject(), undefined, "/home/user/b.html");
    await waitFor(() => expect(issueMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      notifyAllContentLinksRevoked();
    });
    await waitFor(() => expect(issueMock).toHaveBeenCalledTimes(4));
  });

  it("keeps showing a still-valid link when a refresh fails", async () => {
    jest.useFakeTimers();
    issueMock
      .mockResolvedValueOnce({ url: CONTENT_URL, expires_at: Date.now() + 120_000 })
      .mockRejectedValue(new Error("network"));
    renderFrame(freshProject());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(61_000); // refresh fails
    });
    expect(issueMock).toHaveBeenCalledTimes(2);
    const frame = screen.getByTitle("Rendered preview of /home/user/a.html");
    expect(frame.getAttribute("src")).toBe(`${CONTENT_URL}?param=7`);
    expect(frame.getAttribute("srcdoc")).toBeNull();
  });

  it("drops an expired link for the safe preview when the refresh fails", async () => {
    jest.useFakeTimers();
    issueMock
      .mockResolvedValueOnce({ url: CONTENT_URL, expires_at: Date.now() + 30_000 })
      .mockRejectedValue(new Error("network"));
    renderFrame(freshProject());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(31_000); // refresh after expiry fails
    });
    const frame = screen.getByTitle("Rendered preview of /home/user/a.html");
    expect(frame.getAttribute("src")).toBeNull();
    expect(frame.getAttribute("srcdoc")).toBe("<p>hi</p>");
  });

  it("shows a re-issued link at the next save, or shortly before the old one expires, not at once", async () => {
    jest.useFakeTimers();
    const second = CONTENT_URL.replace("/cap/", "/cap2/");
    const third = CONTENT_URL.replace("/cap/", "/cap3/");
    const hour = 3600_000;
    issueMock
      .mockResolvedValueOnce({ url: CONTENT_URL, expires_at: Date.now() + 3 * hour })
      .mockResolvedValueOnce({ url: second, expires_at: Date.now() + 27 * hour })
      .mockResolvedValue({ url: third, expires_at: Date.now() + 99 * hour });
    const project_id = freshProject();
    const view = renderFrame(project_id);
    const src = () =>
      screen.getByTitle("Rendered preview of /home/user/a.html").getAttribute("src");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(src()).toBe(`${CONTENT_URL}?param=7`);
    // Re-issued at 2 h (an hour before expiry), but the page isn't reloaded.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2 * hour + 1000);
    });
    expect(issueMock).toHaveBeenCalledTimes(2);
    expect(src()).toBe(`${CONTENT_URL}?param=7`);
    // A save reloads the frame anyway, so it picks up the new link.
    await act(async () => {
      view.rerender(frameElement(project_id, undefined, "/home/user/a.html", undefined, 8));
    });
    expect(src()).toBe(`${second}?param=8`);

    // Without a save, the switch happens 5 minutes before expiry.
    issueMock.mockReset();
    issueMock
      .mockResolvedValueOnce({ url: CONTENT_URL, expires_at: Date.now() + 3 * hour })
      .mockResolvedValue({ url: second, expires_at: Date.now() + 27 * hour });
    view.unmount();
    renderFrame(freshProject());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2 * hour + 1000);
    });
    expect(src()).toBe(`${CONTENT_URL}?param=7`);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(hour - 5 * 60_000);
    });
    expect(src()).toBe(`${second}?param=7`);
  });

  it("makes the frame active when focus moves into it", async () => {
    issueMock.mockResolvedValue({
      url: CONTENT_URL,
      expires_at: Date.now() + 24 * 3600 * 1000,
    });
    const actions = { set_error: jest.fn(), set_active_id: jest.fn() };
    renderFrame(freshProject(), undefined, "/home/user/a.html", actions);
    const frame = await waitFor(() => {
      const el = screen.getByTitle("Rendered preview of /home/user/a.html");
      expect(el.getAttribute("src")).toBe(`${CONTENT_URL}?param=7`);
      return el as HTMLIFrameElement;
    });
    frame.focus();
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(actions.set_active_id).toHaveBeenCalledWith("f1");
  });
});

describe("IFrameHTML without a content origin", () => {
  it("falls back to the sandboxed preview and the switch when the origin is off", async () => {
    issueMock.mockResolvedValue({ unavailable: "off" });
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

  it("shows only the safe preview, with no switch, when asking fails, and asks again", async () => {
    jest.useFakeTimers();
    const project_id = freshProject();
    set_local_storage(`${project_id}:/home/user/a.html:trust`, "true");
    issueMock.mockRejectedValue(new Error("network"));
    renderFrame(project_id);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    const frame = screen.getByTitle("Rendered preview of /home/user/a.html");
    expect(frame.getAttribute("srcdoc")).toBe("<p>hi</p>");
    expect(frame.getAttribute("src")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(31_000);
    });
    expect(issueMock).toHaveBeenCalledTimes(2);
    // Then backs off: the next attempt waits 60 s, not 30 s.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(31_000);
    });
    expect(issueMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(issueMock).toHaveBeenCalledTimes(3);
  });

  it("starts the backoff over after a success", async () => {
    jest.useFakeTimers();
    issueMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ url: CONTENT_URL, expires_at: Date.now() + 120_000 })
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ url: CONTENT_URL, expires_at: Date.now() + 24 * 3600_000 });
    renderFrame(freshProject());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(31_000); // retry: succeeds
    });
    expect(issueMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(61_000); // re-issue: fails
    });
    expect(issueMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(31_000); // 30 s again, not 60 s
    });
    expect(issueMock).toHaveBeenCalledTimes(4);
  });

  it("backs off up to ten minutes", () => {
    expect([1, 2, 3, 5, 6, 20].map(errorRetryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 480_000, 600_000, 600_000,
    ]);
  });

  it.each([["/home/user/notes.rst"], ["/home/user/page.wiki"], ["/home/user/doc.qmd"]])(
    "keeps %s on the old path",
    async (path) => {
      await act(async () => {
        renderFrame(freshProject(), undefined, path);
      });
      expect(issueMock).not.toHaveBeenCalled();
    },
  );

  it("gives a viewer only the safe preview, never Trusted mode, and doesn't ask again", async () => {
    issueMock.mockResolvedValue({ unavailable: "no-access" });
    const project_id = freshProject();
    set_local_storage(`${project_id}:/home/user/a.html:trust`, "true");
    for (let i = 0; i < 2; i++) {
      const view = renderFrame(project_id);
      await waitFor(() =>
        expect(
          screen.getByTitle("Rendered preview of /home/user/a.html").getAttribute("srcdoc"),
        ).toBe("<p>hi</p>"),
      );
      expect(screen.queryByRole("switch")).toBeNull();
      expect(authedUrlMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.any(String) }),
      );
      view.unmount();
    }
    expect(issueMock).toHaveBeenCalledTimes(1);
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
