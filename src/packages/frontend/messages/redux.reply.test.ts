/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { MessagesActions } from "./redux";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { List as iList, Map as iMap } from "immutable";

describe("MessagesActions.createReply", () => {
  const makeRedux = () =>
    ({
      getStore: () =>
        iMap({
          threads: iMap(),
        }),
    }) as any;

  beforeEach(() => {
    (webapp_client as any).account_id = "me";
  });

  it("drops invalid recipients when replying to a sent message", async () => {
    const actions = new MessagesActions("messages", makeRedux());
    const createDraft = jest
      .spyOn(actions, "createDraft")
      .mockResolvedValue(17 as any);

    await actions.createReply({
      message: {
        id: 5,
        from_id: "me",
        to_ids: [null as any, "target-account", "" as any],
        subject: "Hello",
      } as any,
    });

    expect(createDraft).toHaveBeenCalledWith({
      to_ids: ["target-account"],
      thread_id: 5,
      subject: "Re: Hello",
      body: "",
    });
  });

  it("throws a clear error when no valid reply recipient exists", async () => {
    const actions = new MessagesActions("messages", makeRedux());
    jest.spyOn(actions, "createDraft").mockResolvedValue(17 as any);

    await expect(
      actions.createReply({
        message: {
          id: 5,
          from_id: "me",
          to_ids: [null as any],
          subject: "Hello",
        } as any,
      }),
    ).rejects.toThrow("message has no valid reply recipient");
  });

  it("handles immutable to_ids when replying to a sent message", async () => {
    const actions = new MessagesActions("messages", makeRedux());
    const createDraft = jest
      .spyOn(actions, "createDraft")
      .mockResolvedValue(17 as any);

    await actions.createReply({
      message: iMap({
        id: 5,
        from_id: "me",
        to_ids: iList([null, "target-account"]),
        subject: "Hello",
      }) as any,
    });

    expect(createDraft).toHaveBeenCalledWith({
      to_ids: ["target-account"],
      thread_id: 5,
      subject: "Re: Hello",
      body: "",
    });
  });
});
