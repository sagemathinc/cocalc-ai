/** @jest-environment jsdom */

// Home waits for the site settings before choosing its version
// (util/public-home-experiment.ts), so a visitor assigned another version
// never sees the default page first.

import { act, render, waitFor } from "@testing-library/react";
import * as authApi from "@cocalc/frontend/auth/api";
import PublicApp from "../app";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      addListener: jest.fn(),
      dispatchEvent: jest.fn(),
      removeEventListener: jest.fn(),
      removeListener: jest.fn(),
    }),
  });
});

let authBootstrap: jest.SpiedFunction<
  typeof authApi.getControlPlaneAuthBootstrap
>;
beforeEach(async () => {
  await import("../home/app");
  authBootstrap = jest.spyOn(authApi, "getControlPlaneAuthBootstrap");
  authBootstrap.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  authBootstrap.mockRestore();
  window.history.replaceState(null, "", "/");
});

function stubFetch(customize: Promise<Response>) {
  global.fetch = jest.fn((url: any) =>
    `${url}`.endsWith("customize")
      ? customize
      : Promise.resolve({ ok: true } as Response),
  ) as typeof fetch;
}

const running = (setting: string) =>
  ({
    ok: true,
    json: async () => ({
      configuration: {
        cocalc_product: "launchpad",
        site_name: "CoCalc",
        public_home_experiment: setting,
      },
    }),
  }) as Response;

describe("Home and the site settings", () => {
  it("shows nothing until the settings arrive, then only the assigned version", async () => {
    const customize = deferred<Response>();
    stubFetch(customize.promise);
    const { container } = render(
      <PublicApp initialRoute={{ section: "home" }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // No default page in the meantime.
    expect(container.querySelector("h1")).toBeNull();
    await act(async () => {
      customize.resolve(running("math:1, project:1"));
    });
    await waitFor(() => expect(container.querySelector("h1")).not.toBeNull());
    expect(["hv-math-title", "hp-title"]).toContain(
      container.querySelector("h1")?.id,
    );
  });

  it("renders a ?home= preview at once", async () => {
    window.history.replaceState(null, "", "/?home=demo");
    stubFetch(new Promise(() => {}));
    const { container } = render(
      <PublicApp initialRoute={{ section: "home" }} />,
    );
    await waitFor(() =>
      expect(container.querySelector("h1")?.id).toBe("hd-title"),
    );
  });
});
