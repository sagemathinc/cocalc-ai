/** @jest-environment jsdom */

jest.mock("react-dom/client", () => ({
  createRoot: jest.fn(),
}));

import { createRoot } from "react-dom/client";

import { init } from "../bootstrap";

describe("public home bootstrap", () => {
  const fetchMock = jest.fn();
  const render = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (global as any).fetch = fetchMock;
    (createRoot as jest.Mock).mockReturnValue({ render });
    document.body.innerHTML = '<div id="cocalc-webapp-container"></div>';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps retrying customize before rendering", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/customize")) {
        const customizeAttempt = fetchMock.mock.calls.filter(([path]) =>
          String(path).endsWith("/customize"),
        ).length;
        if (customizeAttempt < 3) {
          return Promise.reject(new Error("customize unavailable"));
        }
        return Promise.resolve({
          json: async () => ({
            configuration: { site_name: "Launchpad" },
          }),
        });
      }
      if (url.endsWith("/api/v2/news/list")) {
        return Promise.resolve({
          json: async () => [],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const initPromise = init();
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);
    await initPromise;

    expect(
      fetchMock.mock.calls.filter(([url]) => url.endsWith("/customize")),
    ).toHaveLength(3);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
