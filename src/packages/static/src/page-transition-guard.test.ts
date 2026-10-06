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

  it("ignores navigations without a view transition", () => {
    new Function(guardScript())();
    expect(() =>
      window.dispatchEvent(
        Object.assign(new Event("pagereveal"), { viewTransition: null }),
      ),
    ).not.toThrow();
  });
});
