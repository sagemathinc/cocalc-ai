/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { MessagesActions } from "./redux";
import { webapp_client } from "@cocalc/frontend/webapp-client";

describe("MessagesActions.createReply", () => {
  beforeEach(() => {
    (webapp_client as any).account_id = "me";
  });

  it("drops invalid recipients when replying to a sent message", async () => {
    const actions = new MessagesActions("messages", {} as any);
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
    const actions = new MessagesActions("messages", {} as any);
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
});
