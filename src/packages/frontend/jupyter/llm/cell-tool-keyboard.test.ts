/** @jest-environment jsdom */

import { stopKeyboardPropagation } from "./cell-tool";

describe("stopKeyboardPropagation", () => {
  it("stops keyboard event propagation for modal/composer inputs", () => {
    const event = {
      stopPropagation: jest.fn(),
    } as any;
    stopKeyboardPropagation(event);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
