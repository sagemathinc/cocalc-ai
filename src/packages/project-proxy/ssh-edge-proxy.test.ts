/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "node:events";
import { createServer, connect } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { startManagedSshEdgeProxy } from "./ssh-edge-proxy";
import { canonicalizeSshRemoteAddrParts } from "./ssh-remote-addr";

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("managed ssh edge proxy", () => {
  it("records downstream bytes against the authenticated ssh identity", async () => {
    const payload = Buffer.from("hello over ssh");
    const upstream = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        if (!buffered.includes("\r\n")) return;
        socket.write(payload);
        socket.end();
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const identities = new Map<string, any>();
    const record = jest.fn().mockResolvedValue(undefined);
    const noteUpstreamBytes = jest.fn();
    const checkAllowed = jest.fn().mockResolvedValue({ allowed: true });
    const clearIdentity = jest.fn((remote_addr: string) => {
      identities.delete(remote_addr);
    });

    const proxy = await startManagedSshEdgeProxy({
      port: 0,
      host: "127.0.0.1",
      upstreamPort,
      flush_interval_ms: 25,
      getIdentity: (remote_addr) => identities.get(remote_addr),
      clearIdentity,
      checkAllowed,
      record,
      noteUpstreamBytes,
    });
    const proxyPort = (proxy.address() as AddressInfo).port;
    const client = connect({ host: "127.0.0.1", port: proxyPort });
    await once(client, "connect");
    const remote_addr = canonicalizeSshRemoteAddrParts(
      client.localAddress!,
      client.localPort!,
    );
    identities.set(remote_addr, {
      remote_addr,
      project_id: "11111111-1111-4111-8111-111111111111",
      account_id: "22222222-2222-4222-8222-222222222222",
    });

    const chunks: Buffer[] = [];
    client.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    await once(client, "close");
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(Buffer.concat(chunks)).toEqual(payload);
    expect(record).toHaveBeenCalledWith({
      remote_addr,
      project_id: "11111111-1111-4111-8111-111111111111",
      account_id: "22222222-2222-4222-8222-222222222222",
      bytes: payload.length,
      partial: true,
    });
    expect(noteUpstreamBytes).toHaveBeenCalledWith({
      remote_addr,
      project_id: "11111111-1111-4111-8111-111111111111",
      account_id: "22222222-2222-4222-8222-222222222222",
      bytes: payload.length,
    });
    expect(checkAllowed).toHaveBeenCalled();
    expect(clearIdentity).toHaveBeenCalledWith(remote_addr);

    await closeServer(proxy);
    await closeServer(upstream);
  });
});
