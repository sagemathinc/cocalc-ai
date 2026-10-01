/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS,
  COLLABORATION_ROOM_REPLACEMENT_MAX_PATH_BYTES,
  CollaborationRoomReplacementError,
  collaborationRoomReplacementOperationId,
  planCollaborationRoomReplacement,
  validateCollaborationRoomReplacementReceipt,
  validateCollaborationRoomReplacementRequest,
} from "./collaboration-room-replacement";
import type {
  CollaborationRoomReplacementErrorCode,
  CollaborationRoomReplacementReceipt,
} from "./collaboration-room-replacement";

const PROJECT = "aaaaaaaa-1111-4111-8111-111111111111";
const ACCOUNT = "bbbbbbbb-2222-4222-8222-222222222222";
const HOST = "cccccccc-3333-4333-8333-333333333333";
const ROOM = "dddddddd-4444-4444-8444-444444444444";
const REQUEST = "eeeeeeee-5555-4555-8555-555555555555";
const EPOCH = "ffffffff-6666-4666-8666-666666666666";
const OTHER = "abcdefab-7777-4777-8777-777777777777";
const PATH = "/home/user/.cocalc/collaborators.chat";
type Input = Parameters<typeof planCollaborationRoomReplacement>[0];

function fixture(): Input {
  return {
    request: {
      version: 1,
      project_id: PROJECT,
      request_id: REQUEST,
      expected_room_id: ROOM,
      expected_chat_path: PATH,
    },
    authority: {
      project_id: PROJECT,
      requesting_account_id: ACCOUNT,
      requester_role: "owner",
      authenticated_host_id: HOST,
      current_host_id: HOST,
    },
    current_room: {
      project_id: PROJECT,
      room_id: ROOM,
      chat_path: PATH,
      initialized: true,
    },
    current_source_epoch: EPOCH,
    receipt: null,
    absence: {
      status: "missing",
      project_id: PROJECT,
      requesting_account_id: ACCOUNT,
      host_id: HOST,
      request_id: REQUEST,
      room_id: ROOM,
      chat_path: PATH,
      source_epoch: EPOCH,
    },
    retained_operations: 0,
  };
}

function commit(input = fixture()) {
  const plan = planCollaborationRoomReplacement(input);
  if (plan.action !== "commit") throw Error("expected commit plan");
  return plan;
}

function replay(): Input {
  const { room, receipt } = commit();
  return { ...fixture(), receipt, current_room: room, absence: undefined };
}

function rejects(input: Input, code: CollaborationRoomReplacementErrorCode) {
  expect(() => planCollaborationRoomReplacement(input)).toThrow(
    new CollaborationRoomReplacementError(code),
  );
}

describe("canonical human room replacement planning", () => {
  it("uses only the trusted Lite home for allocation, with the root persisted in its receipt", () => {
    const input = fixture();
    input.authority.room_home = "/tmp/lite-project";
    input.request.expected_chat_path =
      "/tmp/lite-project/.cocalc/collaborators.chat";
    input.current_room!.chat_path = input.request.expected_chat_path;
    input.absence!.chat_path = input.request.expected_chat_path;
    const plan = commit(input);
    expect(plan.room.chat_path).toBe(
      `/tmp/lite-project/.cocalc/conversations/${plan.room.room_id}.chat`,
    );
    expect(plan.receipt.room_home).toBe("/tmp/lite-project");
    expect(validateCollaborationRoomReplacementReceipt(plan.receipt)).toEqual(
      plan.receipt,
    );
    delete input.authority.room_home;
    rejects(input, "invalid_request");
  });

  it("does not allow a public caller to select the allocation root", () => {
    expect(() =>
      validateCollaborationRoomReplacementRequest({
        ...fixture().request,
        room_home: "/tmp",
      }),
    ).toThrow("invalid_request");
  });
  it("preserves the v1 persisted identity derivation", () => {
    const { receipt } = commit();
    expect(receipt.operation_id).toBe("bc3c882a-859c-57e8-8be1-b9892c9e875e");
    expect(receipt.replacement.room_id).toBe(
      "761df088-d66a-599b-bf90-d29616ba1c26",
    );
    expect(receipt.retired_source_epoch).toBe(
      "fcd84734-3b27-5199-a123-c9aceb8eb18a",
    );
  });

  it("allocates a stable new identity/path with an explicit pointer and source CAS", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const plan = commit(input);
    expect(commit()).toEqual(plan);
    expect(JSON.stringify(input)).toBe(before);
    expect(plan.expected).toEqual({
      room: input.current_room,
      source_epoch: EPOCH,
    });
    expect(plan.room).toEqual({
      project_id: PROJECT,
      room_id: plan.receipt.replacement.room_id,
      chat_path: `/home/user/.cocalc/conversations/${plan.room.room_id}.chat`,
      initialized: false,
    });
    expect(plan.room.room_id).not.toBe(ROOM);
    expect(plan.room.chat_path).not.toBe(PATH);
    expect(plan.receipt.retired_source_epoch).not.toBe(EPOCH);
    expect(plan.receipt.previous_source_epoch).toBe(EPOCH);
    expect(plan.receipt.requesting_account_id).toBe(ACCOUNT);
    expect(plan.receipt.committing_host_id).toBe(HOST);
    expect(
      validateCollaborationRoomReplacementReceipt(
        JSON.parse(JSON.stringify(plan.receipt)),
      ),
    ).toEqual(plan.receipt);
    expect(JSON.stringify(plan).length).toBeLessThan(4096);
  });

  it("does not share mutable state with request or authoritative input", () => {
    const input = fixture();
    const plan = commit(input);
    plan.receipt.request.expected_chat_path = "/home/user/other.chat";
    plan.expected.room.initialized = false;
    plan.room.chat_path = "/home/user/changed.chat";
    expect(input).toEqual(fixture());
    expect(plan.receipt.replacement.chat_path).not.toBe(plan.room.chat_path);
  });

  it("keys operations by project, human and request, normalizing UUID case", () => {
    const key = collaborationRoomReplacementOperationId(
      PROJECT,
      ACCOUNT,
      REQUEST,
    );
    expect(
      collaborationRoomReplacementOperationId(
        PROJECT.toUpperCase(),
        ACCOUNT.toUpperCase(),
        REQUEST.toUpperCase(),
      ),
    ).toBe(key);
    expect(
      new Set([
        key,
        collaborationRoomReplacementOperationId(OTHER, ACCOUNT, REQUEST),
        collaborationRoomReplacementOperationId(PROJECT, OTHER, REQUEST),
        collaborationRoomReplacementOperationId(PROJECT, ACCOUNT, OTHER),
      ]).size,
    ).toBe(4);
  });

  it("reconciles a lost commit/initialization response without allocating again", () => {
    const input = replay();
    expect(planCollaborationRoomReplacement(input)).toEqual({
      action: "return",
      result: {
        outcome: "pending",
        operation_id: input.receipt!.operation_id,
        room: input.current_room,
      },
    });
    input.current_room!.initialized = true;
    expect(planCollaborationRoomReplacement(input)).toEqual({
      action: "return",
      result: {
        outcome: "ready",
        operation_id: input.receipt!.operation_id,
        room: input.current_room,
      },
    });
  });

  it("uses the current locator after a supported same-project move", () => {
    const input = replay();
    input.current_room!.chat_path = "/home/user/Conversations/moved.chat";
    input.current_room!.initialized = true;
    expect(planCollaborationRoomReplacement(input)).toMatchObject({
      action: "return",
      result: { outcome: "ready", room: input.current_room },
    });
    expect(input.receipt!.replacement.chat_path).not.toBe(
      input.current_room!.chat_path,
    );
  });

  it.each([null, OTHER, ROOM])(
    "returns only a non-actionable superseded result for pointer %s",
    (id) => {
      const input = replay();
      input.current_room =
        id === null ? null : { ...input.current_room!, room_id: id };
      const plan = planCollaborationRoomReplacement(input);
      expect(plan).toEqual({
        action: "return",
        result: {
          outcome: "superseded",
          operation_id: input.receipt!.operation_id,
          replacement_room_id: input.receipt!.replacement.room_id,
        },
      });
      expect(JSON.stringify(plan)).not.toContain("chat_path");
    },
  );

  it("allows a receipt replay after host migration, retirement and capacity exhaustion", () => {
    const input = replay();
    input.authority.authenticated_host_id = OTHER;
    input.authority.current_host_id = OTHER;
    input.current_source_epoch = input.receipt!.retired_source_epoch;
    input.retained_operations = COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS;
    expect(planCollaborationRoomReplacement(input)).toMatchObject({
      action: "return",
      result: { outcome: "pending" },
    });
    expect(input.receipt!.committing_host_id).toBe(HOST);
  });

  it.each(["expected_room_id", "expected_chat_path"] as const)(
    "rejects request ID reuse with a changed %s",
    (field) => {
      const input = replay();
      input.request[field] =
        field === "expected_room_id" ? OTHER : "/home/user/else.chat";
      rejects(input, "operation_conflict");
    },
  );

  it("does not replay another human's operation", () => {
    const input = replay();
    input.authority.requesting_account_id = OTHER;
    rejects(input, "operation_conflict");
  });

  it("does not reconstruct a lost receipt from the new pointer", () => {
    const input = replay();
    input.receipt = null;
    rejects(input, "room_changed");
  });

  it("a competing request cannot overwrite the first committed room", () => {
    const input = replay();
    input.receipt = null;
    input.request.request_id = OTHER;
    rejects(input, "room_changed");
  });

  it.each([fixture, replay])(
    "checks current authority before fresh or replayed operations",
    (make) => {
      let input = make();
      input.authority.requester_role = "collaborator";
      rejects(input, "access_denied");
      input = make();
      input.authority.requester_role = "none";
      rejects(input, "access_denied");
      input = make();
      input.authority.project_id = OTHER;
      rejects(input, "access_denied");
      input = make();
      input.authority.current_host_id = OTHER;
      rejects(input, "stale_host");
      input = make();
      input.authority.current_host_id = null;
      rejects(input, "stale_host");
    },
  );

  it.each(["project_id", "room_id", "chat_path"] as const)(
    "requires expected current %s for a fresh commit",
    (field) => {
      const input = fixture();
      input.current_room![field] =
        field === "chat_path" ? "/home/user/moved.chat" : OTHER;
      rejects(input, "room_changed");
    },
  );

  it("does not replace a never-created or uninitialized room", () => {
    rejects({ ...fixture(), current_room: null }, "room_changed");
    const input = fixture();
    input.current_room!.initialized = false;
    rejects(input, "not_initialized");
  });

  it.each([undefined, "missing"])(
    "requires a structured host absence observation, not %s",
    (absence) => {
      const input = fixture();
      input.absence = absence as unknown as Input["absence"];
      rejects(
        input,
        absence === undefined ? "absence_required" : "invalid_request",
      );
    },
  );

  it.each([
    "project_id",
    "requesting_account_id",
    "host_id",
    "request_id",
    "room_id",
    "chat_path",
  ] as const)("binds absence to %s", (field) => {
    const input = fixture();
    input.absence![field] =
      field === "chat_path" ? "/home/user/else.chat" : OTHER;
    rejects(input, "absence_required");
  });

  it.each(["present", "denied", "corrupt", "wrong-marker"])(
    "does not interpret %s as deletion",
    (status) => {
      const input = fixture();
      input.absence!.status = status as "missing";
      rejects(input, "absence_required");
    },
  );

  it("fences a changed source epoch, including first registration", () => {
    const input = fixture();
    input.current_source_epoch = OTHER;
    rejects(input, "source_changed");
    input.current_source_epoch = null;
    rejects(input, "source_changed");
    input.absence!.source_epoch = null;
    expect(commit(input).expected.source_epoch).toBeNull();
    input.current_source_epoch = EPOCH;
    rejects(input, "source_changed");
  });

  it.each([
    -1,
    1.5,
    NaN,
    Infinity,
    COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS,
  ])(
    "bounds persisted operation count %s without evicting fences",
    (retained_operations) => {
      rejects({ ...fixture(), retained_operations }, "capacity_exceeded");
    },
  );

  it("allows the last available operation slot", () => {
    expect(
      commit({
        ...fixture(),
        retained_operations: COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS - 1,
      }).action,
    ).toBe("commit");
  });
});

describe("bounded replacement wire and persisted contracts", () => {
  it.each([null, [], "room", {}, { ...fixture().request, version: 2 }])(
    "rejects malformed request %p",
    (value) => {
      expect(() => validateCollaborationRoomReplacementRequest(value)).toThrow(
        new CollaborationRoomReplacementError("invalid_request"),
      );
    },
  );

  it.each(["requesting_account_id", "new_room_id", "text", "acp_config"])(
    "rejects public injection of %s",
    (field) => {
      expect(() =>
        validateCollaborationRoomReplacementRequest({
          ...fixture().request,
          [field]: OTHER,
        }),
      ).toThrow("invalid_request");
    },
  );

  it.each(["project_id", "request_id", "expected_room_id"])(
    "validates bounded UUID %s",
    (field) => {
      for (const value of [null, 1, "bad", "a".repeat(100_000)]) {
        expect(() =>
          validateCollaborationRoomReplacementRequest({
            ...fixture().request,
            [field]: value,
          }),
        ).toThrow("invalid_request");
      }
    },
  );

  it.each([
    "room.chat",
    "/home/user/../room.chat",
    "/home/user/./room.chat",
    "/home/user//room.chat",
    "/home/user/a\\room.chat",
    "/home/user/room.chat/",
    "/home/user/room.txt",
    "/home/user/room\u0000.chat",
    "/home/user/room\n.chat",
    "/home/user/room\u007f.chat",
    "/home/user/\ud800.chat",
  ])("rejects an unsafe/noncanonical chat locator %p", (expected_chat_path) => {
    expect(() =>
      validateCollaborationRoomReplacementRequest({
        ...fixture().request,
        expected_chat_path,
      }),
    ).toThrow("invalid_request");
  });

  it("bounds UTF-8 bytes while allowing normal Unicode locators", () => {
    const prefix = "/home/user/";
    const suffix = ".chat";
    const max =
      COLLABORATION_ROOM_REPLACEMENT_MAX_PATH_BYTES -
      prefix.length -
      suffix.length;
    const validate = (part: string) =>
      validateCollaborationRoomReplacementRequest({
        ...fixture().request,
        expected_chat_path: `${prefix}${part}${suffix}`,
      });
    expect(validate("x".repeat(max)).expected_chat_path.length).toBe(
      COLLABORATION_ROOM_REPLACEMENT_MAX_PATH_BYTES,
    );
    expect(() => validate("x".repeat(max + 1))).toThrow("invalid_request");
    expect(() => validate("\u00e9".repeat(max))).toThrow("invalid_request");
    expect(
      validate("\u65e5\u672c\u8a9e-\ud83d\udcac").expected_chat_path,
    ).toContain("\u65e5\u672c\u8a9e");
  });

  it.each([
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.operation_id = OTHER;
    },
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.retired_source_epoch = OTHER;
    },
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.previous_source_epoch = receipt.retired_source_epoch;
    },
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.replacement.project_id = OTHER;
    },
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.replacement.room_id = OTHER;
    },
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.replacement.chat_path = "/home/user/arbitrary.chat";
    },
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.request.expected_room_id = receipt.replacement.room_id;
    },
    (receipt: CollaborationRoomReplacementReceipt) => {
      receipt.request.expected_chat_path = receipt.replacement.chat_path;
    },
  ])("rejects an inconsistent persisted receipt %#", (change) => {
    const receipt = commit().receipt;
    change(receipt);
    expect(() => validateCollaborationRoomReplacementReceipt(receipt)).toThrow(
      new CollaborationRoomReplacementError("invalid_receipt"),
    );
  });

  it("accepts only the bounded receipt schema, without transcripts or personal state", () => {
    const receipt = commit().receipt;
    for (const extra of [
      { text: "history" },
      { following: true },
      { initialized: true },
    ]) {
      expect(() =>
        validateCollaborationRoomReplacementReceipt({ ...receipt, ...extra }),
      ).toThrow("invalid_receipt");
    }
    expect(() =>
      validateCollaborationRoomReplacementReceipt({
        ...receipt,
        replacement: { ...receipt.replacement, text: "history" },
      }),
    ).toThrow("invalid_receipt");
  });
});
