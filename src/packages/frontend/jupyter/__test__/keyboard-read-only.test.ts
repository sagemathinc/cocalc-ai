/** @jest-environment jsdom */

// A read-only notebook (including one whose initial source has not settled,
// a customer report) runs only read-only safe keyboard commands, like the
// menus: e.g. command-mode Z (undo) must not change the live notebook.

const undo = jest.fn();
const selectNext = jest.fn();

jest.mock("../commands", () => ({
  commands: () => ({
    undo: { k: [{ mode: "escape", which: 90 }], f: undo },
    "select next cell": {
      k: [{ mode: "escape", which: 74 }],
      f: selectNext,
      r: true,
    },
  }),
}));

jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  shouldSuppressGlobalShortcuts: () => false,
}));

jest.mock("@cocalc/frontend/project/page/keyboard-navigation", () => ({
  matchProjectNavigationCommand: () => undefined,
  handoffProjectNavigationFromLocalOwner: jest.fn(),
}));

import { create_key_handler } from "../keyboard";

function handler(read_only: boolean) {
  const jupyter_actions: any = {
    store: {
      get: (key: string) => (key === "read_only" ? read_only : undefined),
    },
  };
  const frame_actions: any = {
    store: { get: (key: string) => (key === "mode" ? "escape" : undefined) },
  };
  return create_key_handler(jupyter_actions, frame_actions, {} as any);
}

describe("notebook keyboard commands when read-only", () => {
  beforeEach(() => {
    undo.mockClear();
    selectNext.mockClear();
  });

  it("runs only read-only safe commands", () => {
    const handle = handler(true);
    handle({ which: 90 });
    handle({ which: 74 });
    expect(undo).not.toHaveBeenCalled();
    expect(selectNext).toHaveBeenCalledTimes(1);
  });

  it("runs every command when editable", () => {
    const handle = handler(false);
    handle({ which: 90 });
    handle({ which: 74 });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(selectNext).toHaveBeenCalledTimes(1);
  });
});
