import { fromJS } from "immutable";
import {
  agentMessagingUIEnabled,
  AGENT_MESSAGING_UI_SETTING,
} from "./ui-preference";

test("UI opt-in defaults off and requires literal true for plain and Immutable settings", () => {
  for (const value of [undefined, null, false, 0, 1, "true", "false"]) {
    expect(
      agentMessagingUIEnabled({ [AGENT_MESSAGING_UI_SETTING]: value }),
    ).toBe(false);
    expect(
      agentMessagingUIEnabled(fromJS({ [AGENT_MESSAGING_UI_SETTING]: value })),
    ).toBe(false);
  }
  expect(agentMessagingUIEnabled(undefined)).toBe(false);
  expect(agentMessagingUIEnabled({ [AGENT_MESSAGING_UI_SETTING]: true })).toBe(
    true,
  );
  expect(
    agentMessagingUIEnabled(fromJS({ [AGENT_MESSAGING_UI_SETTING]: true })),
  ).toBe(true);
});
