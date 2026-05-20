/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { deleteRememberMe, hasRememberMe, setRememberMe } from "../remember-me";

describe("remember-me local storage hint", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("sets and deletes the remembered client marker", () => {
    expect(hasRememberMe("/")).toBe(false);

    setRememberMe("/");
    expect(hasRememberMe("/")).toBe(true);

    deleteRememberMe("/");
    expect(hasRememberMe("/")).toBe(false);
  });

  test("normalizes leading slash in base path", () => {
    setRememberMe("/launchpad");

    expect(hasRememberMe("launchpad")).toBe(true);
    expect(window.localStorage.getItem("remember_melaunchpad")).toBe("true");
  });
});
