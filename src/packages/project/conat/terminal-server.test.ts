import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is_valid_uuid_string } from "@cocalc/util/misc";
import { applyTerminalInitFile, projectScopedCliEnv } from "./terminal-server";

describe("terminal-server init file support", () => {
  it("adds --init-file for bash terminals with a matching init file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cocalc-terminal-init-"));
    const termPath = join(dir, ".example.term-0.term");
    const initPath = join(dir, "..example.term-0.term.init");
    await writeFile(initPath, "echo hi\n");

    await expect(
      applyTerminalInitFile({
        command: "bash",
        args: [],
        options: {
          id: termPath,
          path: "example.term",
        },
      }),
    ).resolves.toMatchObject({
      args: ["--init-file", "..example.term-0.term.init"],
      initFilename: initPath,
      hasTerminalInitFile: true,
    });
  });

  it("does nothing for non-bash terminals", async () => {
    await expect(
      applyTerminalInitFile({
        command: "zsh",
        args: [],
        options: {
          id: "/tmp/.example.term-0.term",
          path: "example.term",
        },
      }),
    ).resolves.toMatchObject({
      args: [],
      hasTerminalInitFile: false,
    });
  });

  it("provides project-scoped cocalc cli env for spawned terminals", () => {
    const env = projectScopedCliEnv();
    expect(is_valid_uuid_string(env.COCALC_PROJECT_ID)).toBe(true);
    expect(env.COCALC_API_URL).toMatch(/^https?:\/\//);
    expect(env.COCALC_SECRET_TOKEN).toMatch(/secret-token$/);
  });
});
