import { authorizedKeyLineForTunnelRow } from "./onprem-sshd";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial";
const HOST = "7a1e7841-a2d0-461f-83f0-6f1dcc44174a";

describe("authorizedKeyLineForTunnelRow (054 C containment)", () => {
  it("writes permitlisten only for valid integer ports", () => {
    const line = authorizedKeyLineForTunnelRow({
      host_id: HOST,
      http_tunnel_port: "41000",
      ssh_tunnel_port: 41001,
      tunnel_public_key: KEY,
    });
    expect(line).toBe(
      `permitlisten="0.0.0.0:41000",permitlisten="0.0.0.0:41001",no-agent-forwarding,no-X11-forwarding,no-pty ${KEY} host-${HOST}`,
    );
  });

  it("drops an invalid port and keeps the valid one", () => {
    const line = authorizedKeyLineForTunnelRow({
      host_id: HOST,
      http_tunnel_port: '1",command="/bin/sh',
      ssh_tunnel_port: 41001,
      tunnel_public_key: KEY,
    });
    expect(line).toBe(
      `permitlisten="0.0.0.0:41001",no-agent-forwarding,no-X11-forwarding,no-pty ${KEY} host-${HOST}`,
    );
  });

  it("writes no line when no port is valid", () => {
    for (const [http, ssh] of [
      ["22", "80"],
      ["70000", null],
      ["127.0.0.1:22", "x"],
      [null, null],
    ]) {
      expect(
        authorizedKeyLineForTunnelRow({
          host_id: HOST,
          http_tunnel_port: http,
          ssh_tunnel_port: ssh,
          tunnel_public_key: KEY,
        }),
      ).toBeNull();
    }
  });
});
