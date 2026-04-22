import { chatroom } from "../editor";

describe("chat editor component", () => {
  it("renders a loading fallback when chat actions are not ready", () => {
    const element = chatroom.component({
      id: "frame-a",
      actions: {
        getChatActions: () => undefined,
      },
    } as any) as any;

    expect(element).toBeTruthy();
    expect(element.props.theme).toBe("medium");
  });
});
