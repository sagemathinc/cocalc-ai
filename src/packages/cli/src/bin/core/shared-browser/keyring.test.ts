import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SHARED_BROWSER_KEY_SECRET } from "@cocalc/util/shared-browser";

import {
  decodeMessage,
  encodeMessage,
  ERROR,
  keyFingerprint,
  messageLength,
  METHOD_CALL,
  METHOD_RETURN,
  profileSecret,
  readBrowserKey,
  secretServiceCall,
  splitSignature,
  startBrowserKeyring,
  Variant,
  type DbusMessage,
} from "./keyring";
import { profileForKey } from "./service";

const COLLECTION = "/org/freedesktop/secrets/collection/login";
const ITEM = `${COLLECTION}/1`;
const SESSION = "/org/freedesktop/secrets/session/1";

test("D-Bus signatures split into complete types", () => {
  assert.deepEqual(splitSignature("a{o(oayays)}"), ["a{o(oayays)}"]);
  assert.deepEqual(splitSignature("aoo"), ["ao", "o"]);
  assert.deepEqual(splitSignature("sva{ss}b"), ["s", "v", "a{ss}", "b"]);
  assert.throws(() => splitSignature("a{ss"));
  assert.throws(() => splitSignature("z"));
});

test("D-Bus messages survive encoding, with alignment and nesting", () => {
  const message: DbusMessage = {
    type: METHOD_RETURN,
    serial: 7,
    replySerial: 3,
    destination: ":1.4",
    sender: ":1.0",
    signature: "ya{o(oayays)}vta{sv}x",
    body: [
      9,
      [[ITEM, [SESSION, Buffer.alloc(0), Buffer.from("k3y"), "text/plain"]]],
      new Variant("ao", [COLLECTION]),
      12345678901234n,
      [
        ["Label", new Variant("s", "Login")],
        ["Locked", new Variant("b", false)],
      ],
      -5n,
    ],
  };
  const bytes = encodeMessage(message);
  assert.equal(messageLength(bytes), bytes.length);
  assert.equal(messageLength(bytes.subarray(0, bytes.length - 1)), null);
  const decoded = decodeMessage(bytes);
  assert.equal(decoded.type, METHOD_RETURN);
  assert.equal(decoded.serial, 7);
  assert.equal(decoded.replySerial, 3);
  assert.equal(decoded.destination, ":1.4");
  assert.equal(decoded.signature, message.signature);
  const [y, secrets, variant, t, props, x] = decoded.body!;
  assert.equal(y, 9);
  assert.equal(secrets[0][0], ITEM);
  assert.equal(secrets[0][1][2].toString(), "k3y");
  assert.equal(secrets[0][1][3], "text/plain");
  assert.deepEqual(variant, new Variant("ao", [COLLECTION]));
  assert.equal(t, 12345678901234n);
  assert.deepEqual(
    props.map(([k, v]: [string, Variant]) => [k, v.value]),
    [
      ["Label", "Login"],
      ["Locked", false],
    ],
  );
  assert.equal(x, -5n);
});

test("the Secret Service hands out the key for Chromium only, read-only", () => {
  const secret = Buffer.from("derived-key");
  const call = (
    path: string,
    iface: string,
    member: string,
    body: any[] = [],
  ) =>
    secretServiceCall(
      { type: METHOD_CALL, serial: 1, path, interface: iface, member, body },
      secret,
    );
  const SERVICE = "/org/freedesktop/secrets";
  const S = "org.freedesktop.Secret";
  assert.deepEqual(call(SERVICE, `${S}.Service`, "ReadAlias", ["default"]), [
    "o",
    [COLLECTION],
  ]);
  assert.deepEqual(
    call(COLLECTION, "org.freedesktop.DBus.Properties", "Get", [
      `${S}.Collection`,
      "Label",
    ]),
    ["v", [new Variant("s", "Login")]],
  );
  assert.deepEqual(call(SERVICE, `${S}.Service`, "Unlock", [[COLLECTION]]), [
    "aoo",
    [[COLLECTION], "/"],
  ]);
  assert.equal(
    call(SERVICE, `${S}.Service`, "OpenSession", [
      "plain",
      new Variant("s", ""),
    ])[1][1],
    SESSION,
  );
  assert.throws(() =>
    call(SERVICE, `${S}.Service`, "OpenSession", [
      "dh-ietf1024-sha256-aes128-cbc-pkcs7",
      new Variant("ay", Buffer.alloc(0)),
    ]),
  );
  assert.deepEqual(
    call(COLLECTION, `${S}.Collection`, "SearchItems", [
      [["application", "chromium"]],
    ]),
    ["ao", [[ITEM]]],
  );
  assert.deepEqual(
    call(COLLECTION, `${S}.Collection`, "SearchItems", [
      [["application", "something-else"]],
    ]),
    ["ao", [[]]],
  );
  const [signature, [value]] = call(ITEM, `${S}.Item`, "GetSecret", [SESSION]);
  assert.equal(signature, "(oayays)");
  assert.equal(value[2].toString(), "derived-key");
  assert.throws(
    () => call(COLLECTION, `${S}.Collection`, "CreateItem", [{}, [], true]),
    /holds only/,
  );
});

test("each browser gets its own key from the project key", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const a = profileSecret(key, "cocalc-browser");
  const b = profileSecret(key, "cocalc-browser-0123456789abcdef");
  assert.notEqual(a.toString(), b.toString());
  assert.equal(a.toString(), profileSecret(key, "cocalc-browser").toString());
  assert.notEqual(
    a.toString(),
    profileSecret(
      Buffer.from("another key of enough length"),
      "cocalc-browser",
    ).toString(),
  );
  assert.ok(!a.toString().includes(key.toString()));
  assert.equal(keyFingerprint(null), null);
  assert.match(keyFingerprint(a)!, /^[0-9a-f]{32}$/);
});

test("the project key is read from the secrets mount", () => {
  const dir = mkdtempSync(join(tmpdir(), "keyring-test-"));
  try {
    const env = { COCALC_SECRETS: dir };
    assert.equal(readBrowserKey(env), null);
    writeFileSync(join(dir, SHARED_BROWSER_KEY_SECRET), "short");
    assert.equal(readBrowserKey(env), null);
    writeFileSync(
      join(dir, SHARED_BROWSER_KEY_SECRET),
      "a-long-enough-random-key-value",
    );
    assert.equal(
      readBrowserKey(env)?.toString(),
      "a-long-enough-random-key-value",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a profile from another key, or from before keys, starts over", () => {
  const dir = mkdtempSync(join(tmpdir(), "keyring-profile-"));
  const path = join(dir, "profile");
  try {
    const a = Buffer.from("secret-a");
    // New.
    assert.equal(profileForKey(path, a), false);
    writeFileSync(join(path, "Cookies"), "a's cookies");
    // Same key: kept.
    assert.equal(profileForKey(path, a), false);
    assert.equal(readFileSync(join(path, "Cookies"), "utf8"), "a's cookies");
    // Another key: removed.
    assert.equal(profileForKey(path, Buffer.from("secret-b")), true);
    assert.equal(existsSync(join(path, "Cookies")), false);
    // From before keys (no marker): removed.
    rmSync(path, { recursive: true });
    mkdirSync(path);
    writeFileSync(join(path, "Cookies"), "unencrypted");
    assert.equal(profileForKey(path, a), true);
    assert.equal(existsSync(join(path, "Cookies")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A D-Bus client the way libdbus talks: SASL EXTERNAL, then messages.
async function dbusClient(address: string) {
  const socket = connect(address.replace(/^unix:path=/, ""));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let pending = Buffer.alloc(0);
  const waiters: ((m: DbusMessage) => void)[] = [];
  const queue: DbusMessage[] = [];
  let lineWaiter: ((line: string) => void) | null = null;
  let binary = false;
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (!binary) {
      const end = pending.indexOf("\r\n");
      if (end >= 0 && lineWaiter) {
        const line = pending.toString("latin1", 0, end);
        pending = pending.subarray(end + 2);
        const w = lineWaiter;
        lineWaiter = null;
        w(line);
      }
      return;
    }
    for (;;) {
      const n = messageLength(pending);
      if (n == null) break;
      const m = decodeMessage(pending.subarray(0, n));
      pending = pending.subarray(n);
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    }
  });
  const line = (text: string) =>
    new Promise<string>((resolve) => {
      lineWaiter = resolve;
      socket.write(text);
    });
  const uid = Buffer.from(`${process.getuid?.() ?? 0}`).toString("hex");
  assert.match(await line(`\0AUTH EXTERNAL ${uid}\r\n`), /^OK [0-9a-f]{32}$/);
  assert.equal(await line("NEGOTIATE_UNIX_FD\r\n"), "ERROR");
  binary = true;
  socket.write("BEGIN\r\n");
  let serial = 1;
  const next = () =>
    new Promise<DbusMessage>((resolve) => {
      const m = queue.shift();
      if (m) resolve(m);
      else waiters.push(resolve);
    });
  const call = async (m: Omit<DbusMessage, "serial" | "type">) => {
    const s = serial++;
    socket.write(encodeMessage({ ...m, type: METHOD_CALL, serial: s }));
    for (;;) {
      const reply = await next();
      if (reply.replySerial === s) return reply;
    }
  };
  return { call, close: () => socket.destroy() };
}

test("the keyring is a bus Chromium's client can use", async () => {
  const keyring = await startBrowserKeyring({ secret: Buffer.from("s3cret") });
  const client = await dbusClient(keyring.address);
  try {
    const BUS = {
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
    };
    const hello = await client.call({ ...BUS, member: "Hello" });
    assert.equal(hello.type, METHOD_RETURN);
    assert.match(hello.body![0], /^:1\.\d+$/);
    const has = await client.call({
      ...BUS,
      member: "NameHasOwner",
      signature: "s",
      body: ["org.freedesktop.secrets"],
    });
    assert.deepEqual(has.body, [true]);
    const secret = await client.call({
      destination: "org.freedesktop.secrets",
      path: ITEM,
      interface: "org.freedesktop.Secret.Item",
      member: "GetSecret",
      signature: "o",
      body: [SESSION],
    });
    assert.equal(secret.type, METHOD_RETURN);
    assert.equal(secret.body![0][2].toString(), "s3cret");
    const other = await client.call({
      destination: "org.freedesktop.Notifications",
      path: "/org/freedesktop/Notifications",
      interface: "org.freedesktop.Notifications",
      member: "Notify",
    });
    assert.equal(other.type, ERROR);
    assert.equal(other.errorName, "org.freedesktop.DBus.Error.ServiceUnknown");
  } finally {
    client.close();
    await keyring.close();
  }
  assert.equal(existsSync(keyring.address.replace(/^unix:path=/, "")), false);
});
