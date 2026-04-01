export {};

import { parseDustOutput } from "./storage-breakdown";

describe("storage-breakdown.parseDustOutput", () => {
  it("turns truncated dust output into a clear large-folder error", () => {
    expect(() =>
      parseDustOutput(
        {
          stdout: Buffer.from(""),
          stderr: Buffer.from(
            "Indexing: /mnt/cocalc/project-big 14961 files, 65032452668B ... \\",
          ),
          code: null,
          truncated: true,
        },
        "/home/user",
      ),
    ).toThrow(
      "Disk usage scan for '/home/user' took too long on this large folder. Browse into a smaller folder and try again.",
    );
  });

  it("parses valid dust json into a relative child breakdown", () => {
    const result = parseDustOutput(
      {
        stdout: Buffer.from(
          JSON.stringify({
            size: "123b",
            name: "/home/user",
            children: [
              { size: "100b", name: "/home/user/a" },
              { size: "23b", name: "/home/user/b" },
            ],
          }),
        ),
        stderr: Buffer.from(""),
        code: 0,
        truncated: false,
      },
      "/home/user",
    );

    expect(result).toEqual({
      path: "/home/user",
      bytes: 123,
      children: [
        { bytes: 100, path: "a" },
        { bytes: 23, path: "b" },
      ],
      collected_at: expect.any(String),
    });
  });

  it("maps host-side dust paths back to project-visible paths", () => {
    const result = parseDustOutput(
      {
        stdout: Buffer.from(
          JSON.stringify({
            size: "123b",
            name: "/mnt/cocalc/project-abc",
            children: [
              { size: "100b", name: "/mnt/cocalc/project-abc/cocalc-ai" },
              {
                size: "23b",
                name: "/mnt/cocalc/project-abc/.local/share/cocalc",
              },
            ],
          }),
        ),
        stderr: Buffer.from(""),
        code: 0,
        truncated: false,
      },
      "/root",
    );

    expect(result).toEqual({
      path: "/root",
      bytes: 123,
      children: [
        { bytes: 100, path: "cocalc-ai" },
        { bytes: 23, path: ".local/share/cocalc" },
      ],
      collected_at: expect.any(String),
    });
  });
});
