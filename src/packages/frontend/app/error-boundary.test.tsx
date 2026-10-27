/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CocalcErrorBoundary } from "./error-boundary";
import {
  reloadForFrontendBuild,
  reportStaleChunkError,
} from "./frontend-build-monitor";
import { isReactDomMutationError } from "./react-dom-mutation";
import {
  COCALC_REACT_ERROR_EVENT,
  reactRootErrorHandlers,
  type ReactErrorEventDetail,
} from "./react-error-reporting";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { on: jest.fn(), removeListener: jest.fn() },
}));
jest.mock("./frontend-build-monitor", () => {
  const actual = jest.requireActual("./frontend-build-monitor");
  return {
    ...actual,
    reloadForFrontendBuild: jest.fn(),
    reportStaleChunkError: jest.fn(actual.reportStaleChunkError),
  };
});

describe("CocalcErrorBoundary", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("automatically remounts a subtree once after a transient render error", async () => {
    let failures = 0;
    function TransientFailure() {
      // React retries a concurrent render once before consulting the nearest
      // boundary. Fail both attempts, then let the boundary retry succeed.
      if (failures < 2) {
        failures += 1;
        throw new Error("transient");
      }
      return <div>Recovered content</div>;
    }

    render(
      <CocalcErrorBoundary autoRetry scope="test.transient">
        <TransientFailure />
      </CocalcErrorBoundary>,
      {
        onCaughtError: () => {},
        onRecoverableError: () => {},
      },
    );

    expect(await screen.findByText("Recovered content")).toBeInTheDocument();
    expect(
      screen.queryByText("This part of CoCalc could not be displayed."),
    ).not.toBeInTheDocument();
  });

  it("recovers one DOM mutation quietly and escalates a recurrence", async () => {
    const attempts = new Map<number, number>();
    const onAutoRetry = jest.fn();
    const reports: ReactErrorEventDetail[] = [];
    const listener = (event: Event) => {
      reports.push((event as CustomEvent<ReactErrorEventDetail>).detail);
    };
    window.addEventListener(COCALC_REACT_ERROR_EVENT, listener);

    function DomMutationFailure({ episode }: { episode: number }) {
      const attempt = attempts.get(episode) ?? 0;
      attempts.set(episode, attempt + 1);
      if (attempt < 2) {
        throw Object.assign(
          new Error(
            "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
          ),
          { name: "NotFoundError" },
        );
      }
      return <div>Editor content {episode}</div>;
    }

    const boundary = (episode: number) => (
      <CocalcErrorBoundary
        autoRetry={({ error, retryCount }) =>
          retryCount === 0 && isReactDomMutationError(error)
        }
        fallback={({ error }) =>
          isReactDomMutationError(error) ? (
            <div>Disable page translation or extensions</div>
          ) : (
            <div>Generic failure</div>
          )
        }
        onAutoRetry={onAutoRetry}
        scope="project.editor"
      >
        <DomMutationFailure episode={episode} />
      </CocalcErrorBoundary>
    );

    const { rerender } = render(boundary(1), {
      onCaughtError: reactRootErrorHandlers.onCaughtError,
      onRecoverableError: () => {},
    });

    expect(await screen.findByText("Editor content 1")).toBeInTheDocument();
    expect(onAutoRetry).toHaveBeenCalledWith({
      error: expect.objectContaining({ name: "NotFoundError" }),
      retryCount: 1,
      scope: "project.editor",
    });

    rerender(boundary(2));

    expect(
      await screen.findByText("Disable page translation or extensions"),
    ).toBeInTheDocument();
    expect(onAutoRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(reports.map(({ boundaryAction }) => boundaryAction)).toEqual([
        "auto-retry",
        "fallback",
      ]);
    });
    expect(reports.map(({ boundaryRetryCount }) => boundaryRetryCount)).toEqual(
      [0, 1],
    );

    window.removeEventListener(COCALC_REACT_ERROR_EVENT, listener);
  });

  it("does not announce recovery when the automatic remount also fails", async () => {
    const onAutoRetry = jest.fn();

    function PersistentDomMutationFailure() {
      throw Object.assign(
        new Error(
          "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
        ),
        { name: "NotFoundError" },
      );
    }

    render(
      <CocalcErrorBoundary
        autoRetry={({ error, retryCount }) =>
          retryCount === 0 && isReactDomMutationError(error)
        }
        fallback={<div>Browser changed the editor DOM</div>}
        onAutoRetry={onAutoRetry}
        scope="project.editor"
      >
        <PersistentDomMutationFailure />
      </CocalcErrorBoundary>,
      {
        onCaughtError: reactRootErrorHandlers.onCaughtError,
        onRecoverableError: () => {},
      },
    );

    expect(
      await screen.findByText("Browser changed the editor DOM"),
    ).toBeInTheDocument();
    expect(onAutoRetry).not.toHaveBeenCalled();
  });

  it("does not automatically remount a failed subtree by default", async () => {
    let failures = 0;
    function Failure() {
      failures += 1;
      throw new Error("persistent");
    }

    render(
      <CocalcErrorBoundary scope="test.manual">
        <Failure />
      </CocalcErrorBoundary>,
      {
        onCaughtError: () => {},
        onRecoverableError: () => {},
      },
    );

    expect(
      await screen.findByText("This part of CoCalc could not be displayed."),
    ).toBeInTheDocument();
    const failuresAfterFallback = failures;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failures).toBe(failuresAfterFallback);
  });

  it("shows a local fallback and supports a manual retry", async () => {
    let shouldThrow = true;
    const reports: ReactErrorEventDetail[] = [];
    const listener = (event: Event) => {
      reports.push((event as CustomEvent<ReactErrorEventDetail>).detail);
    };
    window.addEventListener(COCALC_REACT_ERROR_EVENT, listener);

    function PersistentFailure() {
      if (shouldThrow) {
        throw new Error("persistent");
      }
      return <div>Working again</div>;
    }

    render(
      <CocalcErrorBoundary scope="projects.list">
        <PersistentFailure />
      </CocalcErrorBoundary>,
      {
        onCaughtError: reactRootErrorHandlers.onCaughtError,
        onRecoverableError: () => {},
      },
    );

    expect(
      await screen.findByText("This part of CoCalc could not be displayed."),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-error-boundary="projects.list"]'),
    ).not.toBeNull();
    await waitFor(() => {
      expect(reports.length).toBeGreaterThan(0);
    });
    expect(
      reports.every(({ boundaryScope }) => boundaryScope === "projects.list"),
    ).toBe(true);

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByText("Working again")).toBeInTheDocument();
    });
    window.removeEventListener(COCALC_REACT_ERROR_EVENT, listener);
  });

  it("resets a failed region when its navigation key changes", async () => {
    function Content({ route }: { route: string }) {
      if (route === "broken") {
        throw new Error("broken route");
      }
      return <div>Healthy route</div>;
    }

    const { rerender } = render(
      <CocalcErrorBoundary
        autoRetry={false}
        resetKeys={["broken"]}
        scope="app.active-content"
      >
        <Content route="broken" />
      </CocalcErrorBoundary>,
      {
        onCaughtError: () => {},
        onRecoverableError: () => {},
      },
    );

    expect(
      await screen.findByText("This part of CoCalc could not be displayed."),
    ).toBeInTheDocument();

    rerender(
      <CocalcErrorBoundary
        autoRetry={false}
        resetKeys={["healthy"]}
        scope="app.active-content"
      >
        <Content route="healthy" />
      </CocalcErrorBoundary>,
    );

    expect(await screen.findByText("Healthy route")).toBeInTheDocument();
  });

  it("offers a reload, not a retry, when a chunk of an older build is gone", async () => {
    function StaleChunk(): never {
      const error = new Error(
        "Loading chunk 4242 failed. (missing: https://cocalc.example/static/4242.abcdef0123456789.js)",
      );
      error.name = "ChunkLoadError";
      throw error;
    }
    render(
      <CocalcErrorBoundary autoRetry scope="test.stale-chunk">
        <StaleChunk />
      </CocalcErrorBoundary>,
    );

    expect(
      await screen.findByText("CoCalc was updated. Reload to continue."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Try again")).toBeNull();
    // The top bar is told too, since window handlers never see this error.
    expect(reportStaleChunkError).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reloadForFrontendBuild).toHaveBeenCalledTimes(1);
  });

  it("still offers Try again for other errors", async () => {
    function Broken(): never {
      throw new Error("something else");
    }
    render(
      <CocalcErrorBoundary scope="test.other-error">
        <Broken />
      </CocalcErrorBoundary>,
    );

    expect(
      await screen.findByText("This part of CoCalc could not be displayed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("CoCalc was updated. Reload to continue."),
    ).toBeNull();
  });
});
