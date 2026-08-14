/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { evt_to_obj } from "./keyboard";

describe("Jupyter keyboard event normalization", () => {
  it.each([
    [173, 189],
    [59, 186],
  ])(
    "normalizes Firefox key code %s without mutating the event",
    (raw, expected) => {
      const event = Object.freeze({ which: raw });

      expect(evt_to_obj(event, "edit")).toMatchObject({
        mode: "edit",
        which: expected,
      });
      expect(event.which).toBe(raw);

      expect(evt_to_obj(Object.freeze({ which: raw }), "edit")).toMatchObject({
        mode: "edit",
        twice: true,
        which: expected,
      });
    },
  );
});
