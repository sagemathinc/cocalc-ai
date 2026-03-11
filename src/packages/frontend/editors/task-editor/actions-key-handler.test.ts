const mockCreateKeyHandler = jest.fn();

jest.mock("./keyboard", () => ({
  create_key_handler: (...args) => mockCreateKeyHandler(...args),
}));

import { TaskActions } from "./actions";

describe("TaskActions.enable_key_handler", () => {
  beforeEach(() => {
    mockCreateKeyHandler.mockReset();
  });

  it("registers the task key handler against the frame display path", () => {
    const handler = jest.fn();
    mockCreateKeyHandler.mockReturnValue(handler);
    const setActiveKeyHandler = jest.fn();

    TaskActions.prototype.enable_key_handler.call({
      is_closed: false,
      key_handler: undefined,
      getFrameData(key: string) {
        if (key === "display_path") return "/home/wstein/x.tasks";
        return undefined;
      },
      frameActions: {
        set_active_key_handler: setActiveKeyHandler,
      },
    });

    expect(setActiveKeyHandler).toHaveBeenCalledWith(
      handler,
      "/home/wstein/x.tasks",
    );
  });
});
