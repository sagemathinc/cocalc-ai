/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { chatSpeechAccentInstruction, isChatSpeechAccent } from "./speech";

describe("chat speech accents", () => {
  it("validates supported account preferences", () => {
    expect(isChatSpeechAccent("british")).toBe(true);
    expect(isChatSpeechAccent("unsupported")).toBe(false);
  });

  it("maps accent presets to bounded provider instructions", () => {
    expect(chatSpeechAccentInstruction("default")).toBeUndefined();
    expect(chatSpeechAccentInstruction("british")).toBe(
      "Speak with a natural British English accent.",
    );
  });
});
