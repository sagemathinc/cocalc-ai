/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { installBrowserCompatibility } from "./browser-compat";

describe("installBrowserCompatibility", () => {
  const compatibleObject = Object as ObjectConstructor & {
    hasOwn?: (object: object, property: PropertyKey) => boolean;
  };
  const originalHasOwn = Object.getOwnPropertyDescriptor(Object, "hasOwn");

  afterEach(() => {
    if (originalHasOwn == null) {
      delete compatibleObject.hasOwn;
    } else {
      Object.defineProperty(Object, "hasOwn", originalHasOwn);
    }
  });

  it("installs Object.hasOwn without trusting an object's prototype", () => {
    Object.defineProperty(Object, "hasOwn", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    installBrowserCompatibility();

    expect(compatibleObject.hasOwn?.({ value: 1 }, "value")).toBe(true);
    expect(
      compatibleObject.hasOwn?.(
        { hasOwnProperty: () => false },
        "hasOwnProperty",
      ),
    ).toBe(true);
    expect(
      compatibleObject.hasOwn?.(
        Object.create({ inherited: true }),
        "inherited",
      ),
    ).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(Object, "hasOwn")).toBe(
      false,
    );
  });

  it("preserves the native implementation when present", () => {
    const hasOwn = compatibleObject.hasOwn;

    installBrowserCompatibility();

    expect(compatibleObject.hasOwn).toBe(hasOwn);
  });
});
