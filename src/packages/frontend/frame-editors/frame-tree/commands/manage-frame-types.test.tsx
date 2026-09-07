/** @jest-environment jsdom */
import { ManageCommands } from "./manage";

it.each([false, true])(
  "disables unavailable frame types and rechecks on click (new=%s)",
  (createNew) => {
    let unavailable: string | undefined = "Assignment requires Classic";
    const actions = { new_frame: jest.fn(), set_frame_type: jest.fn() };
    const manage = new ManageCommands({
      props: {
        id: "frame",
        type: "classic",
        actions,
        editor_spec: {
          studio: { name: "Studio", unavailable_reason: () => unavailable },
          classic: { name: "Classic" },
        },
      },
    } as any);
    const blocked = manage.frameTypeCommands(createNew)[0];
    expect(blocked.disabled?.(manage)).toBe(true);
    expect(blocked.title).toBe(unavailable);
    (blocked.onClick as Function)();
    expect(actions.new_frame).not.toHaveBeenCalled();
    expect(actions.set_frame_type).not.toHaveBeenCalled();
    unavailable = undefined;
    const allowed = manage.frameTypeCommands(createNew)[0];
    expect(allowed.disabled?.(manage)).toBe(false);
    unavailable = "Metadata arrived while menu was open";
    (allowed.onClick as Function)();
    expect(actions.new_frame).not.toHaveBeenCalled();
    expect(actions.set_frame_type).not.toHaveBeenCalled();
  },
);
