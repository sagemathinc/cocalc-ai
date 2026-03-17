import { parseLsofListenOutput, parseSsOutput } from "./listen-parsers";

describe("app listener parsers", () => {
  test("parseSsOutput extracts IPv4 and IPv6 listeners", () => {
    const raw = [
      "LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*",
      "LISTEN 0 4096 [::1]:7101 [::]:*",
      "",
    ].join("\n");
    expect(parseSsOutput(raw)).toEqual([
      { host: "127.0.0.1", port: 3000 },
      { host: "::1", port: 7101 },
    ]);
  });

  test("parseLsofListenOutput extracts wildcard and loopback listeners", () => {
    const raw = [
      "p578",
      "f14",
      "n*:57472",
      "p1992",
      "f4",
      "n127.0.0.1:49225",
      "p40807",
      "f23",
      "n[::1]:7101",
      "",
    ].join("\n");
    expect(parseLsofListenOutput(raw)).toEqual([
      { host: "0.0.0.0", port: 57472 },
      { host: "127.0.0.1", port: 49225 },
      { host: "::1", port: 7101 },
    ]);
  });
});
