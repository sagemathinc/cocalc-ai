import {
  assertBoardWriteFence,
  BOARD_WRITE_MAX_TTL_MS,
  type BoardWriteFence,
  isBoardWriteNonce,
  isFencedRequest,
} from "./board-write-fence";

const nonce = "0123456789abcdef0123456789abcdef";
const fence: BoardWriteFence = { nonce, assertWritable() {} };

function check(
  request: Record<string, unknown>,
  opts: {
    f?: BoardWriteFence | undefined;
    receivedAt?: number;
    now?: number;
  } = {},
) {
  // ("f" given as undefined means no fence, not the default one)
  const f = "f" in opts ? opts.f : fence;
  const { receivedAt = 1000, now = 1000 } = opts;
  return () => assertBoardWriteFence({ fence: f, request, receivedAt, now });
}

const ok = { cmd: "set", expectedNonce: nonce, ttlMs: 25_000 };

test("a nonce is exactly 32 lowercase hex digits", () => {
  expect(isBoardWriteNonce(nonce)).toBe(true);
  for (const bad of [
    nonce.toUpperCase(),
    nonce.slice(1),
    nonce + "0",
    "",
    null,
    123,
  ]) {
    expect(isBoardWriteNonce(bad)).toBe(false);
  }
});

test("reads pass without a fence; everything else is fenced, unknown commands too", () => {
  for (const cmd of [
    "get",
    "getAll",
    "changefeed",
    "keys",
    "serverId",
    "inventory",
    "checkpoints",
    "metadata",
    "boardInstance",
  ]) {
    expect(isFencedRequest({ cmd })).toBe(false);
    expect(check({ cmd }, { f: undefined })).not.toThrow();
  }
  expect(isFencedRequest({ cmd: "config" })).toBe(false);
  expect(isFencedRequest({ cmd: "config", config: { max_msgs: 1 } })).toBe(
    true,
  );
  for (const cmd of [
    "set",
    "setMany",
    "delete",
    "setMetadata",
    "patchMetadata",
    "resetHistory",
    "setCheckpoint",
    "deleteCheckpoint",
    "sqlite",
    "someFutureCommand",
    undefined,
  ]) {
    expect(isFencedRequest({ cmd })).toBe(true);
  }
});

test("a fenced request with the right nonce and time to live passes", () => {
  expect(check(ok)).not.toThrow();
  expect(check(ok, { receivedAt: 0, now: 25_000 })).not.toThrow();
});

test("without a fence every write is refused 'lock'", () => {
  expect(check(ok, { f: undefined })).toThrow(
    expect.objectContaining({ code: "lock" }),
  );
});

test("a fence that can't write refuses 'lock'", () => {
  const broken: BoardWriteFence = {
    nonce,
    assertWritable() {
      throw Error("the board write lock was replaced");
    },
  };
  expect(check(ok, { f: broken })).toThrow(
    expect.objectContaining({ code: "lock" }),
  );
});

test("another instance's nonce, or none, is refused 'instance'", () => {
  for (const expectedNonce of [
    "fedcba9876543210fedcba9876543210",
    undefined,
    "",
    nonce.toUpperCase(),
  ]) {
    expect(check({ ...ok, expectedNonce })).toThrow(
      expect.objectContaining({ code: "instance" }),
    );
  }
});

test("a missing or invalid time to live is refused 'ttl'", () => {
  for (const ttlMs of [
    undefined,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    "25000",
    BOARD_WRITE_MAX_TTL_MS + 1,
  ]) {
    expect(check({ ...ok, ttlMs })).toThrow(
      expect.objectContaining({ code: "ttl" }),
    );
  }
});

test("a request that waited longer than its time to live is refused 'ttl'", () => {
  expect(check({ ...ok, ttlMs: 100 }, { receivedAt: 0, now: 101 })).toThrow(
    expect.objectContaining({ code: "ttl" }),
  );
  expect(
    check({ ...ok, ttlMs: 100 }, { receivedAt: 0, now: 100 }),
  ).not.toThrow();
});

test("the checks run in order: lock, then instance, then ttl", () => {
  expect(check({ cmd: "set" }, { f: undefined })).toThrow(
    expect.objectContaining({ code: "lock" }),
  );
  expect(check({ cmd: "set", ttlMs: 0 })).toThrow(
    expect.objectContaining({ code: "instance" }),
  );
});
