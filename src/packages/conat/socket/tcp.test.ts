/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Sender } from "./tcp";
import { messageData } from "@cocalc/conat/core/client";

function socketAck(emitted: number) {
  return {
    isRequest: () => true,
    data: { socket: { emitted } },
    respondSync: () => undefined,
  };
}

describe("Conat socket TCP sender", () => {
  it("does not resend or queue while the logical socket cannot send", async () => {
    const sent: any[] = [];
    let canSend = false;
    const sender = new Sender(
      (mesg) => {
        sent.push(mesg);
      },
      "client",
      10,
      () => canSend,
    );
    sender.process(messageData(null));

    const resend = sender.resendLastUntilAcked();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(sent).toHaveLength(1);

    canSend = true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(sent).toHaveLength(2);

    sender.handleRequest(socketAck(1));
    await resend;
    expect(sent).toHaveLength(2);
  });

  it("does not send undefined when there is nothing left to resend", async () => {
    const sent: any[] = [];
    const sender = new Sender(
      (mesg) => {
        sent.push(mesg);
      },
      "client",
      10,
    );
    sender.process(messageData(null));
    sender.handleRequest(socketAck(1));

    await sender.resendLastUntilAcked();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeDefined();
  });
});
