import { TerminalManager } from "./terminal-manager";

describe("TerminalManager teardown races", () => {
  it("ignores focus after the manager has been closed", () => {
    const manager = new TerminalManager({
      _get_most_recent_terminal_id: jest.fn(() => "term-1"),
    } as any);
    (manager as any).terminals = {
      "term-1": {
        focus: jest.fn(),
        close: jest.fn(),
      },
    };

    manager.close();

    expect(() => manager.focus("term-1")).not.toThrow();
    expect(() => manager.focus()).not.toThrow();
  });
});
