/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function guardScript(): string {
  const html = readFileSync(join(__dirname, "app.html"), "utf8");
  const match = html.match(
    /<script id="cocalc-page-transition-guard">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("page transition guard script is missing");
  return match[1];
}

describe("app.html page transition guard", () => {
  it("handles every promise of a revealed or swapped page transition", () => {
    new Function(guardScript())();
    for (const type of ["pagereveal", "pageswap"]) {
      const transition = {
        ready: { catch: jest.fn() },
        finished: { catch: jest.fn() },
        updateCallbackDone: { catch: jest.fn() },
      };
      window.dispatchEvent(
        Object.assign(new Event(type), { viewTransition: transition }),
      );
      expect(transition.ready.catch).toHaveBeenCalled();
      expect(transition.finished.catch).toHaveBeenCalled();
      expect(transition.updateCallbackDone.catch).toHaveBeenCalled();
    }
  });

  // Runs the handler the guard attached to a rejected transition promise.
  function handlerFor(type: string) {
    new Function(guardScript())();
    const promise = { catch: jest.fn() };
    window.dispatchEvent(
      Object.assign(new Event(type), {
        viewTransition: { ready: promise },
      }),
    );
    return promise.catch.mock.calls.at(-1)[0] as (err: unknown) => void;
  }

  it("swallows only the skip and abort rejections the browser raises", () => {
    const handler = handlerFor("pagereveal");
    const domError = (name: string, message: string) =>
      Object.assign(new Error(message), { name });
    expect(() =>
      handler(
        domError(
          "InvalidStateError",
          "Skipping view transition because viewport size changed.",
        ),
      ),
    ).not.toThrow();
    expect(() =>
      handler(
        domError(
          "AbortError",
          "Transition was aborted because of invalid state",
        ),
      ),
    ).not.toThrow();
    const other = domError("TypeError", "Skipping view transition");
    expect(() => handler(other)).toThrow(other);
    const author = new Error("view transition update callback failed");
    expect(() => handler(author)).toThrow(author);
    expect(() => handler(undefined)).toThrow();
  });

  it("ignores navigations without a view transition", () => {
    new Function(guardScript())();
    expect(() =>
      window.dispatchEvent(
        Object.assign(new Event("pagereveal"), { viewTransition: null }),
      ),
    ).not.toThrow();
  });
});
