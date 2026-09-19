import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stageAgentAttachments,
  discardAgentAttachments,
  AttachmentStagingCleanupError,
} from "./attachment-staging";
import { AgentAttachmentReservations } from "./attachment-reservations";
import { AgentRpcCapacity } from "./rpc-capacity";
import { rpcOutcome, type AgentRpcEnvelope } from "./rpc";

function file(name = "receipt.bin", data = Buffer.from([0, 128, 255, 42])) {
  const metadata = {
    name,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  return { metadata, payload: { ...metadata, data } };
}

describe("sandboxed destination attachment staging", () => {
  let root: string;
  let fs: Parameters<typeof stageAgentAttachments>[0];
  const local = (path: string) => {
    if (
      !path.startsWith("/tmp/cocalc-agent-attachments-") ||
      path.split("/").includes("..")
    )
      throw new Error("unexpected test project path");
    return join(root, path.slice(5));
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-staging-test-"));
    fs = {
      mkdir: jest.fn(async (path, options) => {
        await mkdir(local(path), options);
      }),
      writeFile: jest.fn(async (path, data) => {
        await writeFile(local(path), data as Buffer);
      }),
      chmod: jest.fn(async (path, mode) => {
        await chmod(local(path), mode);
      }),
      rm: jest.fn(async (path, options) => {
        await rm(local(path), options);
      }),
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("native binary roundtrip has actual project paths and a byte-free manifest", async () => {
    const f = file();
    const staged = await stageAgentAttachments(fs, [f.metadata], [f.payload]);
    expect(await readFile(local(staged.files[0].path))).toEqual(f.payload.data);
    const manifest = JSON.parse(
      await readFile(local(staged.manifest_path), "utf8"),
    );
    expect(manifest.files).toEqual([
      { ...f.metadata, path: staged.files[0].path },
    ]);
    expect(manifest.temporary).toBe(true);
    expect(manifest.files[0].data).toBeUndefined();
    expect((await stat(local(staged.directory))).mode & 0o777).toBe(0o700);
    expect((await stat(local(staged.files[0].path))).mode & 0o777).toBe(0o600);
    expect((await stat(local(staged.manifest_path))).mode & 0o777).toBe(0o600);
    await discardAgentAttachments(fs, staged);
    expect(await readdir(root)).toEqual([]);
  });

  test("duplicate basenames and a file called manifest.json never overwrite one another", async () => {
    const a = file("manifest.json"),
      b = file("manifest.json", Buffer.from("different"));
    const staged = await stageAgentAttachments(
      fs,
      [a.metadata, b.metadata],
      [a.payload, b.payload],
    );
    expect(await readFile(local(staged.files[0].path))).toEqual(a.payload.data);
    expect(await readFile(local(staged.files[1].path))).toEqual(b.payload.data);
    expect(staged.files[0].path).not.toBe(staged.files[1].path);
    expect(staged.files.map(({ path }) => path)).not.toContain(
      staged.manifest_path,
    );
  });

  test("maximum-length basename still fits without a generated prefix", async () => {
    const f = file("x".repeat(255));
    const staged = await stageAgentAttachments(fs, [f.metadata], [f.payload]);
    expect(await readFile(local(staged.files[0].path))).toEqual(f.payload.data);
  });

  test("a Uint8Array view writes only its selected bytes", async () => {
    const bytes = new Uint8Array([9, 0, 255, 8]);
    const data = bytes.subarray(1, 3);
    const f = file("view.bin", Buffer.from(data));
    const staged = await stageAgentAttachments(
      fs,
      [f.metadata],
      [{ ...f.payload, data }],
    );
    expect(await readFile(local(staged.files[0].path))).toEqual(
      Buffer.from([0, 255]),
    );
  });

  test("bad hashes and paths fail before creating or writing anything", async () => {
    const f = file();
    await expect(
      stageAgentAttachments(
        fs,
        [f.metadata],
        [{ ...f.payload, data: Buffer.alloc(4) }],
      ),
    ).rejects.toThrow("digest");
    const bad = file("../escape");
    await expect(
      stageAgentAttachments(fs, [bad.metadata], [bad.payload]),
    ).rejects.toThrow("manifest");
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test("scratch quota failure removes partial files and never returns a manifest", async () => {
    const a = file("a"),
      b = file("b");
    const write = fs.writeFile;
    fs.writeFile = jest.fn(async (...args) => {
      if (args[0].endsWith("/b"))
        throw Object.assign(new Error("scratch quota exceeded"), {
          code: "ENOSPC",
        });
      await write(...args);
    });
    await expect(
      stageAgentAttachments(
        fs,
        [a.metadata, b.metadata],
        [a.payload, b.payload],
      ),
    ).rejects.toThrow("quota exceeded");
    expect(await readdir(root)).toEqual([]);
    expect(fs.rm).toHaveBeenCalledTimes(1);
  });

  test("manifest write failure also removes successfully written file bytes", async () => {
    const f = file();
    const write = fs.writeFile;
    fs.writeFile = jest.fn(async (...args) => {
      if (args[0].endsWith("/manifest.json"))
        throw new Error("manifest write failed");
      await write(...args);
    });
    await expect(
      stageAgentAttachments(fs, [f.metadata], [f.payload]),
    ).rejects.toThrow("manifest write failed");
    expect(await readdir(root)).toEqual([]);
  });

  test("directory creation failure never deletes an existing directory", async () => {
    const f = file();
    fs.mkdir = jest.fn(async () => {
      throw new Error("EEXIST");
    });
    await expect(
      stageAgentAttachments(fs, [f.metadata], [f.payload]),
    ).rejects.toThrow("EEXIST");
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test("cleanup failures are visible rather than claiming all temporary bytes were removed", async () => {
    const f = file();
    fs.writeFile = jest.fn(async () => {
      throw new Error("write failed");
    });
    fs.rm = jest.fn(async () => {
      throw new Error("cleanup failed");
    });
    await expect(
      stageAgentAttachments(fs, [f.metadata], [f.payload]),
    ).rejects.toBeInstanceOf(AttachmentStagingCleanupError);
  });

  test("discard rejects arbitrary or traversal paths", async () => {
    for (const directory of [
      "/home/user",
      "/tmp",
      "/tmp/cocalc-agent-attachments-../../home/user",
    ])
      await expect(
        discardAgentAttachments(fs, {
          directory,
          manifest_path: "",
          files: [],
        }),
      ).rejects.toThrow("Invalid");
    expect(fs.rm).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "prepared transfer with real file staging, lost acknowledgment=%s",
    async (loseAck) => {
      const f = file();
      const e: AgentRpcEnvelope = {
        version: 3,
        body: "Review this file",
        path: "/home/user/recv.chat",
        source: { project_id: randomUUID(), agent_id: randomUUID() },
        source_label: "@source",
        target: { project_id: randomUUID(), agent_id: randomUUID() },
        target_label: "@target",
        run_id: randomUUID(),
        account_id: randomUUID(),
        agent_session_id: randomUUID(),
        session_generation: randomUUID(),
        account_generation: 0,
        configured_delivery: "queued",
        guidance: false,
        attempt_id: randomUUID(),
        permit_id: randomUUID(),
        thread_id: randomUUID(),
        deadline: Date.now() + 30_000,
      };
      let running = false;
      const reservations = new AgentAttachmentReservations(
        new AgentRpcCapacity(),
        async () => {},
        async () => {
          running = true;
        },
      );
      const request = { envelope: e, files: [f.metadata] };
      const ticket = await reservations.prepare(request);
      expect(fs.writeFile).not.toHaveBeenCalled();
      const adapter = {
        stage: async () => {
          expect(running).toBe(true);
          return stageAgentAttachments(fs, request.files, [f.payload]);
        },
        submit: jest.fn(
          async (staged: Awaited<ReturnType<typeof stageAgentAttachments>>) => {
            expect(await readFile(local(staged.files[0].path))).toEqual(
              f.payload.data,
            );
            if (loseAck)
              throw new Error("execution accepted, acknowledgment lost");
            return rpcOutcome(e, "accepted", { chat_effect: "saved" });
          },
        ),
        discard: jest.fn(
          async (staged: Awaited<ReturnType<typeof stageAgentAttachments>>) => {
            await discardAgentAttachments(fs, staged);
          },
        ),
      };
      const result = reservations.commit(
        ticket.reservation_id,
        request,
        [f.payload],
        adapter,
      );
      if (loseAck) await expect(result).rejects.toThrow("acknowledgment lost");
      else expect((await result).outcome).toBe("accepted");
      await expect(
        reservations.commit(
          ticket.reservation_id,
          request,
          [f.payload],
          adapter,
        ),
      ).rejects.toThrow("unavailable");
      expect(adapter.submit).toHaveBeenCalledTimes(1);
      expect(adapter.discard).not.toHaveBeenCalled();
      expect(await readdir(root)).toHaveLength(1);
      reservations.close();
    },
  );
});
