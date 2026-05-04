/** @jest-environment jsdom */

import { ChatActions } from "../actions";

function makeActions() {
  const redux = {
    getStore: () => null,
    _set_state: () => undefined,
    removeActions: () => undefined,
  } as any;
  return new ChatActions("chat", redux) as ChatActions & { syncdb?: any };
}

describe("ChatActions liveness", () => {
  it("treats an unattached chat actions instance as closed", () => {
    const actions = makeActions();
    expect(actions.isClosed()).toBe(true);
  });

  it("treats a closed syncdb as closed", () => {
    const actions = makeActions();
    actions.syncdb = {
      get_state: () => "closed",
    };
    expect(actions.isClosed()).toBe(true);
  });

  it("keeps a live syncing chat actions instance open", () => {
    const actions = makeActions();
    actions.syncdb = {
      get_state: () => "connecting",
    };
    expect(actions.isClosed()).toBe(false);
  });
});
