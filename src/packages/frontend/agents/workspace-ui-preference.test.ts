import { Map } from "immutable";
import {
  MY_AGENTS_UI_SETTING,
  myAgentsUIEnabled,
} from "./workspace-ui-preference";

describe("myAgentsUIEnabled", () => {
  it("is fail-closed for missing and malformed settings", () => {
    expect(myAgentsUIEnabled(undefined)).toBe(false);
    expect(myAgentsUIEnabled({})).toBe(false);
    expect(myAgentsUIEnabled({ [MY_AGENTS_UI_SETTING]: "true" })).toBe(false);
  });

  it("accepts explicit true in plain and Immutable settings", () => {
    expect(myAgentsUIEnabled({ [MY_AGENTS_UI_SETTING]: true })).toBe(true);
    expect(myAgentsUIEnabled(Map({ [MY_AGENTS_UI_SETTING]: true }))).toBe(true);
  });
});
