import {
  BOARD_WRITE_SERVICE,
  assertBoardCommandAllowed,
  boardStreamAccess,
  classifyStreamPath,
} from "./board-policy";
import { storagePath } from "@cocalc/conat/sync/core-stream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { boardSyncdbPath } from "@cocalc/util/board/names";

const project_id = "00000000-0000-4000-8000-000000000000";
const SERVICE = "persist";

// The storage path a board's syncdb really uses.
function boardStream(path: string): string {
  return storagePath({
    project_id,
    name: patchesStreamName({ path: boardSyncdbPath(path) }),
  });
}

describe("board stream paths", () => {
  it("recognizes a board's stream, as the syncdb names it", () => {
    for (const path of [
      "/home/user/plan.board.json",
      "plan.board.json",
      "/home/user/a b/é.board.json",
      "/home/user/é.board.json",
    ]) {
      expect(classifyStreamPath(boardStream(path))).toEqual({
        board: true,
        canonical: true,
      });
    }
  });

  it("keeps distinct Unicode spellings distinct", () => {
    const nfc = boardStream("/home/user/é.board.json");
    const nfd = boardStream("/home/user/é.board.json");
    expect(nfc).not.toBe(nfd);
  });

  it("is not fooled by other streams", () => {
    for (const path of [
      `projects/${project_id}/patchflow/home/user/a.txt`,
      `projects/${project_id}/other/home/user/.a.board.json.sage-board`,
      `accounts/${project_id}/patchflow/x.sage-board`,
      `hub/patchflow/x.sage-board`,
      undefined,
      42,
    ]) {
      expect(classifyStreamPath(path)).toEqual({ board: false });
    }
  });

  it("refuses non-canonical board paths", () => {
    for (const path of [
      `projects/${project_id}/patchflow//home/user/.a.board.json.sage-board`,
      `projects/${project_id}/patchflow/home/../user/.a.board.json.sage-board`,
      `projects/${project_id}/patchflow/home/./user/.a.board.json.sage-board`,
      `projects/not-a-uuid/patchflow/home/user/.a.board.json.sage-board`,
      `projects/${project_id}/patchflow/home/user/.a\u0007.board.json.sage-board`,
      `projects/${project_id}/patchflow/home/user/.a\ud800.board.json.sage-board`,
      `projects/${project_id}/patchflow/.sage-board/`,
    ]) {
      const cls = classifyStreamPath(path);
      if (cls.board) expect(cls.canonical).toBe(false);
    }
  });
});

describe("who may do what with a board stream", () => {
  const storage = () => ({ path: boardStream("/home/user/plan.board.json") });

  it("the ordinary service may only read, and only durably", () => {
    for (const subject of [
      `${SERVICE}.project-${project_id}`,
      `${SERVICE}.account-${project_id}`,
      `${SERVICE}.hub`,
    ]) {
      const s: any = {
        ...storage(),
        ephemeral: true,
        sync: true,
        compression: { algorithm: 99, threshold: 0 },
        noCache: true,
      };
      const access = boardStreamAccess({
        service: SERVICE,
        subject,
        storage: s,
      });
      // The server's own options: the path, nothing the client chose.
      expect(access).toEqual({
        board: true,
        readOnly: true,
        storage: { path: storage().path },
      });
      for (const cmd of [
        "get",
        "getAll",
        "changefeed",
        "keys",
        "serverId",
        "inventory",
        "checkpoints",
        "metadata",
      ]) {
        expect(() => assertBoardCommandAllowed(access, { cmd })).not.toThrow();
      }
      expect(() =>
        assertBoardCommandAllowed(access, { cmd: "config" }),
      ).not.toThrow();
      for (const request of [
        { cmd: "set" },
        { cmd: "setMany" },
        { cmd: "delete" },
        { cmd: "config", config: { max_msgs: -1 } },
        { cmd: "setMetadata" },
        { cmd: "patchMetadata" },
        { cmd: "resetHistory" },
        { cmd: "setCheckpoint" },
        { cmd: "deleteCheckpoint" },
        { cmd: "sqlite" },
        { cmd: "something-new" },
        {},
      ]) {
        expect(() => assertBoardCommandAllowed(access, request)).toThrow(
          /read-only/,
        );
      }
    }
  });

  it("the board write service serves only the hub, only board streams", () => {
    const access = boardStreamAccess({
      service: BOARD_WRITE_SERVICE,
      subject: `${BOARD_WRITE_SERVICE}.hub`,
      storage: storage(),
    });
    expect(access).toEqual({
      board: true,
      readOnly: false,
      storage: { path: storage().path },
    });
    expect(() =>
      assertBoardCommandAllowed(access, { cmd: "set" }),
    ).not.toThrow();
    for (const subject of [
      `${BOARD_WRITE_SERVICE}.project-${project_id}`,
      `${BOARD_WRITE_SERVICE}.account-${project_id}`,
      `${BOARD_WRITE_SERVICE}.host-${project_id}`,
      `${BOARD_WRITE_SERVICE}.hubx`,
    ]) {
      expect(() =>
        boardStreamAccess({
          service: BOARD_WRITE_SERVICE,
          subject,
          storage: storage(),
        }),
      ).toThrow(/only the host/);
    }
    expect(() =>
      boardStreamAccess({
        service: BOARD_WRITE_SERVICE,
        subject: `${BOARD_WRITE_SERVICE}.hub`,
        storage: { path: `projects/${project_id}/patchflow/home/user/a.txt` },
      }),
    ).toThrow(/only board streams/);
  });

  it("other streams are untouched", () => {
    const s: any = {
      path: `projects/${project_id}/patchflow/home/user/a.txt`,
      ephemeral: true,
    };
    const access = boardStreamAccess({
      service: SERVICE,
      subject: `${SERVICE}.project-${project_id}`,
      storage: s,
    });
    expect(access).toEqual({ board: false, readOnly: false });
    expect(s.ephemeral).toBe(true);
    expect(() =>
      assertBoardCommandAllowed(access, { cmd: "resetHistory" }),
    ).not.toThrow();
  });

  it("a non-canonical board path is refused", () => {
    expect(() =>
      boardStreamAccess({
        service: SERVICE,
        subject: `${SERVICE}.project-${project_id}`,
        storage: {
          path: `projects/${project_id}/patchflow/home/../x/.a.board.json.sage-board`,
        },
      }),
    ).toThrow(/canonical/);
  });
});
