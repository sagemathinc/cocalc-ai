import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeTurnMentionFile } from "../turn-mention-file";

it("binds the current identity and replaces prior turn references, including with an empty map", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-mentions-"));
  const identityPath = path.join(dir, "identity.json");
  try {
    await fs.writeFile(
      identityPath,
      JSON.stringify({
        agent_id: "agent",
        run_id: "P-run",
        token: "never-copy",
      }),
    );
    const first = await materializeTurnMentionFile({
      identityPath,
      identityHostPath: identityPath,
      references: [
        {
          version: 1,
          naming_account_id: "P",
          name: "reviewer",
          target: { project_id: "project", agent_id: "reviewer-P" },
        },
      ],
    });
    const record = JSON.parse(await fs.readFile(first.file!, "utf8"));
    expect(record).toEqual({
      agent_id: "agent",
      run_id: "P-run",
      references: [
        {
          name: "reviewer",
          target: { project_id: "project", agent_id: "reviewer-P" },
        },
      ],
    });
    expect((await fs.stat(first.file!)).mode & 0o777).toBe(0o600);
    await first.cleanup();
    await expect(fs.stat(first.file!)).rejects.toThrow();
    const nextIdentityPath = path.join(dir, "identity-Q.json");
    await fs.writeFile(
      nextIdentityPath,
      JSON.stringify({ agent_id: "agent", run_id: "Q-run" }),
    );
    const second = await materializeTurnMentionFile({
      identityPath: nextIdentityPath,
      identityHostPath: nextIdentityPath,
      references: [],
    });
    expect(JSON.parse(await fs.readFile(second.file!, "utf8"))).toEqual({
      agent_id: "agent",
      run_id: "Q-run",
      references: [],
    });
    expect(second.file).not.toBe(first.file);
    await second.cleanup();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("does not invent identity credentials when unavailable", async () => {
  expect(
    await materializeTurnMentionFile({ references: [] }),
  ).not.toHaveProperty("file");
  await expect(
    materializeTurnMentionFile({
      references: [
        {
          version: 1,
          naming_account_id: "P",
          name: "reviewer",
          target: { project_id: "project", agent_id: "reviewer" },
        },
      ],
    }),
  ).rejects.toThrow("Scoped agent identity");
});
