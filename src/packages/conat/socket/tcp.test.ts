/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Receiver, Sender } from "./tcp";
import { messageData } from "@cocalc/conat/core/client";
import { SOCKET_HEADER_SEQ } from "./util";

function socketAck(emitted: number) {
  return {
    isRequest: () => true,
    data: { socket: { emitted } },
    respondSync: () => undefined,
  };
}

describe("Conat socket TCP sender", () => {
  it("automatically resends the latest unacked message after a grace period", async () => {
    const sent: any[] = [];
    const sender = new Sender(
      (mesg) => {
        sent.push(mesg);
      },
      "client",
      10,
    );

    sender.process(messageData("first"));
    expect(sent).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(sent.length).toBeGreaterThanOrEqual(2);

    sender.handleRequest(socketAck(1));
    sender.close();
  });

  it("does not automatically resend when the message is acked promptly", async () => {
    const sent: any[] = [];
    const sender = new Sender(
      (mesg) => {
        sent.push(mesg);
      },
      "client",
      10,
    );

    sender.process(messageData("first"));
    sender.handleRequest(socketAck(1));

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(sent).toHaveLength(1);

    sender.close();
  });

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

describe("Conat socket TCP receiver", () => {
  it("retries the ack when a duplicate packet arrives after ack failure", async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error("lost ack"))
      .mockResolvedValueOnce(undefined);
    const reset = jest.fn();
    const receiver = new Receiver(request, reset, "client");
    const received: any[] = [];
    receiver.on("message", (mesg) => {
      received.push(mesg.data);
    });

    receiver.process(
      messageData("first", { headers: { [SOCKET_HEADER_SEQ]: 1 } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1);

    receiver.process(
      messageData("first", { headers: { [SOCKET_HEADER_SEQ]: 1 } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toEqual({ socket: { emitted: 1 } });
    expect(received).toHaveLength(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("resets the logical socket on invalid framing", () => {
    const consoleLog = jest.spyOn(console, "log").mockImplementation();
    const reset = jest.fn();
    const receiver = new Receiver(jest.fn(), reset, "client");

    try {
      receiver.process(messageData("raw terminal output"));

      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      consoleLog.mockRestore();
    }
  });
});
