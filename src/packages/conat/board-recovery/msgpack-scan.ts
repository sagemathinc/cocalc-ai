/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A structural bound on MessagePack bytes, checked before they are decoded.

@msgpack/msgpack's decoder has no depth limit (a few bytes can nest
arbitrarily deep) and allocates from the lengths it reads. scanMsgpack walks
the bytes once, iteratively (an explicit stack, no recursion), and refuses
them unless they are exactly one value that:

- nests at most maxDepth containers deep (a top-level array or map is depth
  1);
- has at most maxElements items in all, counting each array element and
  each map key and value; a container's claimed length is checked against
  what remains of that budget before any of its items is read, so a header
  claiming 2^32 - 1 entries fails at once;
- has no array longer than maxArrayLength, map with more than maxMapLength
  entries, string longer than maxStrLength bytes or bin longer than
  maxBinLength bytes;
- uses no extension types (and no reserved byte);
- ends exactly at the end of the bytes (truncated or trailing bytes fail).

It is O(bytes + items) in time and O(depth) in memory, and allocates nothing
from a claimed length. Only bytes that pass are given to the decoder (with
its own max*Length options as a second bound), and then to a schema.
*/

export interface MsgpackLimits {
  maxDepth: number;
  maxElements: number;
  maxStrLength: number;
  maxBinLength: number;
  maxArrayLength: number;
  maxMapLength: number;
}

export class MsgpackScanError extends Error {
  constructor(message: string) {
    super(`msgpack scan: ${message}`);
  }
}

export function scanMsgpack(bytes: Uint8Array, limits: MsgpackLimits): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  let pos = 0;
  let elements = 0;
  // Items still to read in each open container; the bottom entry is the one
  // top-level value.
  const remaining: number[] = [1];

  const need = (n: number) => {
    if (n > end - pos) throw new MsgpackScanError("truncated");
  };
  const u8 = () => {
    need(1);
    return bytes[pos++];
  };
  const u16 = () => {
    need(2);
    const v = view.getUint16(pos);
    pos += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(pos);
    pos += 4;
    return v;
  };
  const skip = (n: number) => {
    need(n);
    pos += n;
  };
  const str = (n: number) => {
    if (n > limits.maxStrLength) {
      throw new MsgpackScanError(`a string of ${n} bytes`);
    }
    skip(n);
  };
  const bin = (n: number) => {
    if (n > limits.maxBinLength) {
      throw new MsgpackScanError(`a bin of ${n} bytes`);
    }
    skip(n);
  };
  // A container of `length` entries holding `items` items (a map's entries
  // are a key and a value each).
  const open = (items: number, length: number, kind: "array" | "map") => {
    if (
      kind === "array"
        ? length > limits.maxArrayLength
        : length > limits.maxMapLength
    ) {
      throw new MsgpackScanError(`a ${kind} of ${length} entries`);
    }
    // remaining.length is the depth this container is at (the bottom entry
    // is the top level).
    if (remaining.length > limits.maxDepth) {
      throw new MsgpackScanError(`nested over ${limits.maxDepth} deep`);
    }
    if (items > limits.maxElements - elements) {
      throw new MsgpackScanError(`over ${limits.maxElements} items`);
    }
    if (items > 0) remaining.push(items);
  };

  while (remaining.length > 0) {
    const top = remaining.length - 1;
    if (remaining[top] === 0) {
      remaining.pop();
      continue;
    }
    remaining[top] -= 1;
    // The top-level value isn't counted against maxElements; its items
    // are, each one checked as it is reached (a container's claim is also
    // checked when it opens, so a huge claim fails at once).
    if (top > 0) {
      elements += 1;
      if (elements > limits.maxElements) {
        throw new MsgpackScanError(`over ${limits.maxElements} items`);
      }
    }
    const b = u8();
    if (b <= 0x7f || b >= 0xe0) continue; // fixint
    if (b <= 0x8f) {
      const n = b & 0x0f;
      open(2 * n, n, "map");
      continue;
    }
    if (b <= 0x9f) {
      const n = b & 0x0f;
      open(n, n, "array");
      continue;
    }
    if (b <= 0xbf) {
      str(b & 0x1f);
      continue;
    }
    switch (b) {
      case 0xc0: // nil
      case 0xc2: // false
      case 0xc3: // true
        continue;
      case 0xc4:
        bin(u8());
        continue;
      case 0xc5:
        bin(u16());
        continue;
      case 0xc6:
        bin(u32());
        continue;
      case 0xca: // float 32
        skip(4);
        continue;
      case 0xcb: // float 64
        skip(8);
        continue;
      case 0xcc: // uint 8
      case 0xd0: // int 8
        skip(1);
        continue;
      case 0xcd:
      case 0xd1:
        skip(2);
        continue;
      case 0xce:
      case 0xd2:
        skip(4);
        continue;
      case 0xcf:
      case 0xd3:
        skip(8);
        continue;
      case 0xd9:
        str(u8());
        continue;
      case 0xda:
        str(u16());
        continue;
      case 0xdb:
        str(u32());
        continue;
      case 0xdc: {
        const n = u16();
        open(n, n, "array");
        continue;
      }
      case 0xdd: {
        const n = u32();
        open(n, n, "array");
        continue;
      }
      case 0xde: {
        const n = u16();
        open(2 * n, n, "map");
        continue;
      }
      case 0xdf: {
        const n = u32();
        open(2 * n, n, "map");
        continue;
      }
      default:
        // 0xc1 (never used), ext 8/16/32 and fixext.
        throw new MsgpackScanError(
          `type 0x${b.toString(16)} (an extension or a reserved byte)`,
        );
    }
  }
  if (pos !== end) {
    throw new MsgpackScanError(`${end - pos} trailing bytes`);
  }
}
