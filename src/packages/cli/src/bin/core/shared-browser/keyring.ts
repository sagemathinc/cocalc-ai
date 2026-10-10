/**
 * A private keyring for the shared browser's headless Chromium.
 *
 * Chromium on Linux encrypts cookies with a key it keeps in the desktop
 * keyring (the freedesktop Secret Service on the D-Bus session bus).  With no
 * keyring it uses a fixed key that is in Chromium's source, so a copy of the
 * profile (a snapshot, a backup) holds usable sign-ins.  This keyring hands
 * Chromium a key derived from the project secret COCALC_BROWSER_KEY, which is
 * never in snapshots or backups: cookies on disk are useless without it, and
 * replacing or deleting the secret signs every copy out.  Local storage and
 * IndexedDB are not encrypted by Chromium.
 *
 * It is the whole bus: a unix socket that speaks just enough D-Bus for
 * Chromium's own Secret Service client (no dbus-daemon, no libsecret).
 * Measured with Chromium 143: Hello, AddMatch, NameHasOwner, then ReadAlias,
 * Properties.Get(Label), Unlock, OpenSession("plain"),
 * Collection.SearchItems, Item.GetSecret and Session.Close.  A browser that
 * finds no keyring drops the cookies it cannot decrypt, so a persistent
 * profile must only run with this keyring.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SHARED_BROWSER_KEY_SECRET } from "@cocalc/util/shared-browser";

// --- D-Bus marshalling (little-endian out; either endianness in) ---

export class Variant {
  constructor(
    readonly signature: string,
    readonly value: unknown,
  ) {}
}

const BASIC = "ybnqiuxtdsogvh";
const ALIGN: Record<string, number> = {
  y: 1,
  b: 4,
  n: 2,
  q: 2,
  i: 4,
  u: 4,
  x: 8,
  t: 8,
  d: 8,
  s: 4,
  o: 4,
  g: 1,
  v: 1,
  h: 4,
  a: 4,
  "(": 8,
  "{": 8,
};

function typeEnd(signature: string, start: number): number {
  const c = signature[start];
  if (c === "a") return typeEnd(signature, start + 1);
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let i = start + 1;
    while (signature[i] !== close) {
      if (i >= signature.length)
        throw Error(`bad D-Bus signature '${signature}'`);
      i = typeEnd(signature, i);
    }
    return i + 1;
  }
  if (!c || !BASIC.includes(c))
    throw Error(`bad D-Bus signature '${signature}'`);
  return start + 1;
}

/** The complete types of a signature: "a{ss}ob" -> ["a{ss}", "o", "b"]. */
export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  for (let i = 0; i < signature.length; ) {
    const end = typeEnd(signature, i);
    types.push(signature.slice(i, end));
    i = end;
  }
  return types;
}

class Writer {
  private buf = Buffer.alloc(256);
  length = 0;

  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.length + n));
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  pad(alignment: number) {
    const n = (alignment - (this.length % alignment)) % alignment;
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
  }

  bytes(data: Buffer) {
    this.ensure(data.length);
    data.copy(this.buf, this.length);
    this.length += data.length;
  }

  private uint32(value: number) {
    this.pad(4);
    this.ensure(4);
    this.buf.writeUInt32LE(value >>> 0, this.length);
    this.length += 4;
  }

  write(type: string, value: any): void {
    const c = type[0];
    switch (c) {
      case "y":
        this.bytes(Buffer.from([value & 0xff]));
        return;
      case "b":
        return this.uint32(value ? 1 : 0);
      case "n":
      case "q": {
        this.pad(2);
        this.ensure(2);
        if (c === "n") this.buf.writeInt16LE(value, this.length);
        else this.buf.writeUInt16LE(value, this.length);
        this.length += 2;
        return;
      }
      case "i":
        this.pad(4);
        this.ensure(4);
        this.buf.writeInt32LE(value, this.length);
        this.length += 4;
        return;
      case "u":
      case "h":
        return this.uint32(value);
      case "x":
      case "t":
      case "d": {
        this.pad(8);
        this.ensure(8);
        if (c === "x") this.buf.writeBigInt64LE(BigInt(value), this.length);
        else if (c === "t")
          this.buf.writeBigUInt64LE(BigInt(value), this.length);
        else this.buf.writeDoubleLE(value, this.length);
        this.length += 8;
        return;
      }
      case "s":
      case "o": {
        const data = Buffer.from(`${value}`, "utf8");
        this.uint32(data.length);
        this.bytes(data);
        this.bytes(Buffer.from([0]));
        return;
      }
      case "g": {
        const data = Buffer.from(`${value}`, "utf8");
        this.bytes(Buffer.from([data.length]));
        this.bytes(data);
        this.bytes(Buffer.from([0]));
        return;
      }
      case "v": {
        const variant = value as Variant;
        this.write("g", variant.signature);
        this.write(variant.signature, variant.value);
        return;
      }
      case "(": {
        this.pad(8);
        splitSignature(type.slice(1, -1)).forEach((t, i) =>
          this.write(t, value[i]),
        );
        return;
      }
      case "a": {
        const element = type.slice(1);
        this.uint32(0);
        const lengthAt = this.length - 4;
        this.pad(ALIGN[element[0]]);
        const start = this.length;
        if (element === "y") {
          this.bytes(Buffer.from(value));
        } else if (element[0] === "{") {
          const [keyType, valueType] = splitSignature(element.slice(1, -1));
          const entries: [any, any][] =
            value instanceof Map
              ? [...value.entries()]
              : Array.isArray(value)
                ? value
                : Object.entries(value);
          for (const [k, v] of entries) {
            this.pad(8);
            this.write(keyType, k);
            this.write(valueType, v);
          }
        } else {
          for (const item of value) this.write(element, item);
        }
        this.buf.writeUInt32LE(this.length - start, lengthAt);
        return;
      }
      default:
        throw Error(`cannot write D-Bus type '${type}'`);
    }
  }

  result(): Buffer {
    return this.buf.subarray(0, this.length);
  }
}

class Reader {
  offset = 0;
  constructor(
    private readonly buf: Buffer,
    private readonly little: boolean,
  ) {}

  pad(alignment: number) {
    this.offset += (alignment - (this.offset % alignment)) % alignment;
  }

  private uint32(): number {
    this.pad(4);
    const v = this.little
      ? this.buf.readUInt32LE(this.offset)
      : this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  read(type: string): any {
    const c = type[0];
    const le = this.little;
    switch (c) {
      case "y":
        return this.buf[this.offset++];
      case "b":
        return this.uint32() !== 0;
      case "n":
      case "q": {
        this.pad(2);
        const v =
          c === "n"
            ? le
              ? this.buf.readInt16LE(this.offset)
              : this.buf.readInt16BE(this.offset)
            : le
              ? this.buf.readUInt16LE(this.offset)
              : this.buf.readUInt16BE(this.offset);
        this.offset += 2;
        return v;
      }
      case "i": {
        this.pad(4);
        const v = le
          ? this.buf.readInt32LE(this.offset)
          : this.buf.readInt32BE(this.offset);
        this.offset += 4;
        return v;
      }
      case "u":
      case "h":
        return this.uint32();
      case "x":
      case "t":
      case "d": {
        this.pad(8);
        const at = this.offset;
        this.offset += 8;
        if (c === "x")
          return le ? this.buf.readBigInt64LE(at) : this.buf.readBigInt64BE(at);
        if (c === "t")
          return le
            ? this.buf.readBigUInt64LE(at)
            : this.buf.readBigUInt64BE(at);
        return le ? this.buf.readDoubleLE(at) : this.buf.readDoubleBE(at);
      }
      case "s":
      case "o": {
        const n = this.uint32();
        const v = this.buf.toString("utf8", this.offset, this.offset + n);
        this.offset += n + 1;
        return v;
      }
      case "g": {
        const n = this.buf[this.offset++];
        const v = this.buf.toString("utf8", this.offset, this.offset + n);
        this.offset += n + 1;
        return v;
      }
      case "v": {
        const signature = this.read("g");
        return new Variant(signature, this.read(signature));
      }
      case "(": {
        this.pad(8);
        return splitSignature(type.slice(1, -1)).map((t) => this.read(t));
      }
      case "a": {
        const element = type.slice(1);
        const n = this.uint32();
        this.pad(ALIGN[element[0]]);
        const end = this.offset + n;
        if (end > this.buf.length) throw Error("D-Bus array past the end");
        if (element === "y") {
          const v = Buffer.from(this.buf.subarray(this.offset, end));
          this.offset = end;
          return v;
        }
        const items: any[] = [];
        if (element[0] === "{") {
          const [keyType, valueType] = splitSignature(element.slice(1, -1));
          while (this.offset < end) {
            this.pad(8);
            items.push([this.read(keyType), this.read(valueType)]);
          }
          return items;
        }
        while (this.offset < end) items.push(this.read(element));
        return items;
      }
      default:
        throw Error(`cannot read D-Bus type '${type}'`);
    }
  }
}

export const METHOD_CALL = 1;
export const METHOD_RETURN = 2;
export const ERROR = 3;
export const SIGNAL = 4;
const NO_REPLY_EXPECTED = 0x1;

export interface DbusMessage {
  type: number;
  flags?: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature?: string;
  body?: any[];
}

const FIELDS: [keyof DbusMessage, number, string][] = [
  ["path", 1, "o"],
  ["interface", 2, "s"],
  ["member", 3, "s"],
  ["errorName", 4, "s"],
  ["replySerial", 5, "u"],
  ["destination", 6, "s"],
  ["sender", 7, "s"],
  ["signature", 8, "g"],
];

export function encodeMessage(message: DbusMessage): Buffer {
  const signature = message.signature ?? "";
  const body = new Writer();
  const values = message.body ?? [];
  splitSignature(signature).forEach((t, i) => body.write(t, values[i]));
  const bodyBytes = body.result();
  const header = new Writer();
  header.write("y", "l".charCodeAt(0));
  header.write("y", message.type);
  header.write("y", message.flags ?? 0);
  header.write("y", 1);
  header.write("u", bodyBytes.length);
  header.write("u", message.serial);
  const fields: [number, Variant][] = [];
  for (const [key, code, type] of FIELDS) {
    const value = key === "signature" ? signature || undefined : message[key];
    if (value != null) fields.push([code, new Variant(type, value)]);
  }
  header.write("a(yv)", fields);
  header.pad(8);
  return Buffer.concat([header.result(), bodyBytes]);
}

/** The size of the first message in buf, or null until all of it arrived. */
export function messageLength(buf: Buffer): number | null {
  if (buf.length < 16) return null;
  const little = buf[0] === "l".charCodeAt(0);
  const bodyLength = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLength = little ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLength = 16 + fieldsLength + ((8 - (fieldsLength % 8)) % 8);
  const total = headerLength + bodyLength;
  if (total > MAX_MESSAGE_BYTES) throw Error("D-Bus message too large");
  return buf.length >= total ? total : null;
}

const MAX_MESSAGE_BYTES = 1 << 20;

export function decodeMessage(buf: Buffer): DbusMessage {
  const little = buf[0] === "l".charCodeAt(0);
  if (!little && buf[0] !== "B".charCodeAt(0))
    throw Error("bad D-Bus endianness");
  const r = new Reader(buf, little);
  r.offset = 1;
  const type = r.read("y");
  const flags = r.read("y");
  r.read("y");
  r.read("u");
  const serial = r.read("u");
  const message: DbusMessage = { type, flags, serial };
  for (const [code, variant] of r.read("a(yv)") as [number, Variant][]) {
    const field = FIELDS.find(([, c]) => c === code);
    if (field) (message as any)[field[0]] = variant.value;
  }
  r.pad(8);
  message.body = splitSignature(message.signature ?? "").map((t) =>
    r.read(t),
  );
  return message;
}

// --- The project key ---

/** The project secret's bytes, or null if there is no usable secret. */
export function readBrowserKey(env: NodeJS.ProcessEnv = process.env) {
  const dir = `${env.COCALC_SECRETS ?? ""}`.trim() || "/run/secrets/cocalc";
  try {
    const key = readFileSync(join(dir, SHARED_BROWSER_KEY_SECRET));
    return key.toString("utf8").trim().length >= 16 ? key : null;
  } catch {
    return null;
  }
}

/** What one browser's Chromium gets: its own key, from the project key. */
export function profileSecret(key: Buffer, appId: string): Buffer {
  return Buffer.from(
    createHmac("sha256", key)
      .update(`cocalc-browser-profile:${appId}`)
      .digest("base64"),
  );
}

/** Names a key without revealing it (stored next to the profile). */
export function keyFingerprint(secret: Buffer | null): string | null {
  return secret
    ? createHash("sha256").update(secret).digest("hex").slice(0, 32)
    : null;
}

// --- The bus and the Secret Service ---

const BUS = "org.freedesktop.DBus";
const SECRETS = "org.freedesktop.secrets";
const SERVICE_OWNER = ":1.0";
const SERVICE_PATH = "/org/freedesktop/secrets";
const COLLECTION = "/org/freedesktop/secrets/collection/login";
const ITEM = `${COLLECTION}/1`;
const SESSION = "/org/freedesktop/secrets/session/1";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const SECRET = "org.freedesktop.Secret";
// Chromium's application name for this key (both Chromium and Chrome).
const APPLICATIONS = new Set(["chromium", "chrome"]);

class DbusError extends Error {
  constructor(
    readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

type Reply = [signature: string, body: any[]];

function properties(path: string): Record<string, Record<string, Variant>> {
  if (path === SERVICE_PATH)
    return {
      [`${SECRET}.Service`]: { Collections: new Variant("ao", [COLLECTION]) },
    };
  if (path === COLLECTION)
    return {
      [`${SECRET}.Collection`]: {
        Label: new Variant("s", "Login"),
        Locked: new Variant("b", false),
        Items: new Variant("ao", [ITEM]),
      },
    };
  if (path === ITEM)
    return {
      [`${SECRET}.Item`]: {
        Label: new Variant("s", "Chromium Safe Storage"),
        Locked: new Variant("b", false),
        Attributes: new Variant("a{ss}", { application: "chromium" }),
      },
    };
  return {};
}

function matches(attributes: [string, string][]): string[] {
  const application = attributes.find(([k]) => k === "application")?.[1];
  return application && APPLICATIONS.has(application) ? [ITEM] : [];
}

export function secretServiceCall(
  message: DbusMessage,
  secret: Buffer,
): Reply {
  const { path = "", member = "" } = message;
  const iface = message.interface ?? "";
  const body = message.body ?? [];
  const secretStruct = [SESSION, Buffer.alloc(0), secret, "text/plain"];
  if (iface === PROPERTIES) {
    const all = properties(path)[body[0]];
    if (member === "GetAll") return ["a{sv}", [all ?? {}]];
    if (member === "Get") {
      const value = all?.[body[1]];
      if (!value)
        throw new DbusError(
          `${BUS}.Error.UnknownProperty`,
          `no property ${body[1]}`,
        );
      return ["v", [value]];
    }
  }
  if (path === SERVICE_PATH && iface === `${SECRET}.Service`) {
    switch (member) {
      case "OpenSession":
        if (body[0] !== "plain")
          throw new DbusError(
            `${BUS}.Error.NotSupported`,
            "only the plain algorithm",
          );
        return ["vo", [new Variant("s", ""), SESSION]];
      case "ReadAlias":
        return ["o", [body[0] === "default" ? COLLECTION : "/"]];
      case "Unlock":
        return ["aoo", [body[0], "/"]];
      case "SearchItems":
        return ["aoao", [matches(body[0]), []]];
      case "GetSecrets":
        return [
          "a{o(oayays)}",
          [
            (body[0] as string[])
              .filter((item) => item === ITEM)
              .map((item) => [item, secretStruct]),
          ],
        ];
    }
  }
  if (path === COLLECTION && iface === `${SECRET}.Collection`) {
    if (member === "SearchItems") return ["ao", [matches(body[0])]];
    if (member === "CreateItem")
      throw new DbusError(
        `${BUS}.Error.AccessDenied`,
        "this keyring holds only the project's browser key",
      );
  }
  if (path === ITEM && iface === `${SECRET}.Item` && member === "GetSecret")
    return ["(oayays)", [secretStruct]];
  if (path === SESSION && iface === `${SECRET}.Session` && member === "Close")
    return ["", []];
  throw new DbusError(
    `${BUS}.Error.UnknownMethod`,
    `no method ${iface}.${member} at ${path}`,
  );
}

function busCall(message: DbusMessage, uniqueName: string, guid: string) {
  const name = message.body?.[0];
  switch (message.member) {
    case "Hello":
      return ["s", [uniqueName]] as Reply;
    case "AddMatch":
    case "RemoveMatch":
    case "Ping":
      return ["", []] as Reply;
    case "GetId":
      return ["s", [guid]] as Reply;
    case "NameHasOwner":
      return ["b", [name === SECRETS || name === BUS]] as Reply;
    case "GetNameOwner":
      if (name === SECRETS) return ["s", [SERVICE_OWNER]] as Reply;
      if (name === BUS) return ["s", [BUS]] as Reply;
      throw new DbusError(`${BUS}.Error.NameHasNoOwner`, `no owner: ${name}`);
    case "ListNames":
      return ["as", [[BUS, SECRETS, SERVICE_OWNER]]] as Reply;
    case "ListActivatableNames":
      return ["as", [[BUS]]] as Reply;
  }
  throw new DbusError(
    `${BUS}.Error.AccessDenied`,
    `${message.member} is not available on this bus`,
  );
}

export interface BrowserKeyring {
  /** For DBUS_SESSION_BUS_ADDRESS. */
  address: string;
  close: () => Promise<void>;
}

export async function startBrowserKeyring({
  secret,
  log,
}: {
  secret: Buffer;
  log?: (message: string) => void;
}): Promise<BrowserKeyring> {
  // Only this user can reach the socket; the same user can read the project
  // secret anyway.
  const dir = mkdtempSync(join(tmpdir(), "cocalc-keyring-"));
  const socketPath = join(dir, "bus");
  const guid = randomBytes(16).toString("hex");
  let nextClient = 1;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const uniqueName = `:1.${nextClient++}`;
    let serial = 1;
    let authenticated = false;
    let pending = Buffer.alloc(0);

    const send = (message: Omit<DbusMessage, "serial">) =>
      socket.write(encodeMessage({ ...message, serial: serial++ }));

    const handle = (message: DbusMessage) => {
      if (message.type !== METHOD_CALL) return;
      const toBus = message.destination === BUS;
      const toService =
        message.destination === SECRETS ||
        message.destination === SERVICE_OWNER;
      let reply: Reply;
      try {
        if (toBus) reply = busCall(message, uniqueName, guid);
        else if (toService) reply = secretServiceCall(message, secret);
        else
          throw new DbusError(
            `${BUS}.Error.ServiceUnknown`,
            `${message.destination ?? "(none)"} is not on this bus`,
          );
      } catch (err) {
        if ((message.flags ?? 0) & NO_REPLY_EXPECTED) return;
        const dbusErr =
          err instanceof DbusError
            ? err
            : new DbusError(`${BUS}.Error.Failed`, `${err}`);
        send({
          type: ERROR,
          errorName: dbusErr.name,
          replySerial: message.serial,
          destination: uniqueName,
          sender: toBus ? BUS : SERVICE_OWNER,
          signature: "s",
          body: [dbusErr.message],
        });
        return;
      }
      if (!((message.flags ?? 0) & NO_REPLY_EXPECTED))
        send({
          type: METHOD_RETURN,
          replySerial: message.serial,
          destination: uniqueName,
          sender: toBus ? BUS : SERVICE_OWNER,
          signature: reply[0],
          body: reply[1],
        });
      if (toBus && message.member === "Hello")
        send({
          type: SIGNAL,
          path: "/org/freedesktop/DBus",
          interface: BUS,
          member: "NameAcquired",
          destination: uniqueName,
          sender: BUS,
          signature: "s",
          body: [uniqueName],
        });
    };

    // SASL: a NUL byte, then lines, until BEGIN.
    const authenticate = () => {
      if (pending[0] === 0) pending = pending.subarray(1);
      for (;;) {
        const end = pending.indexOf("\r\n");
        if (end < 0) return;
        const line = pending.toString("latin1", 0, end);
        pending = pending.subarray(end + 2);
        const [command, ...args] = line.split(" ");
        if (command === "BEGIN") {
          authenticated = true;
          return;
        }
        if (command === "AUTH" && args[0] === "EXTERNAL")
          socket.write(args[1] != null ? `OK ${guid}\r\n` : "DATA\r\n");
        else if (command === "DATA") socket.write(`OK ${guid}\r\n`);
        else if (command === "AUTH" || command === "CANCEL")
          socket.write("REJECTED EXTERNAL\r\n");
        else socket.write("ERROR\r\n");
      }
    };

    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        if (!authenticated) authenticate();
        while (authenticated) {
          const n = messageLength(pending);
          if (n == null) break;
          const message = decodeMessage(pending.subarray(0, n));
          pending = pending.subarray(n);
          handle(message);
        }
      } catch (err) {
        log?.(`keyring: ${(err as Error)?.message ?? err}`);
        socket.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    address: `unix:path=${socketPath}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
