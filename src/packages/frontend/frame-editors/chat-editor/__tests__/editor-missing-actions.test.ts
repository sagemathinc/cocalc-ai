import { chatroom } from "../editor";

describe("chat editor component", () => {
  it("renders a loading fallback when chat actions are not ready", () => {
    const getChatActions = jest.fn(() => undefined);
    const element = chatroom.component({
      id: "frame-a",
      actions: {
        getChatActions,
      },
    } as any) as any;

    expect(getChatActions).toHaveBeenCalledWith("frame-a", {
      allowMissingFrameType: true,
    });
    expect(element).toBeTruthy();
    expect(element.props.theme).toBe("medium");
  });
});
