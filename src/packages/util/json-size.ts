/*
Capped size measurements that never build the serialization they measure
(bounded history plan H1b-2, LIMIT-H1B2P-2):

- utf8LengthCapped: the UTF-8 length of a string, counted in place;
- jsonLengthCapped: the length of JSON.stringify(value), walked with an
  explicit stack (no recursion), without listing an object's keys, and
  giving up as soon as the length passes the cap.

Both give up (return undefined) rather than under-count: past the cap, past
the depth cap, or at any value whose JSON.stringify output they do not
reproduce exactly (toJSON, Map, Set, typed arrays, BigInt, class instances,
cycles).

The byte cap alone does not bound the work: members JSON.stringify omits
(undefined, functions, symbols) and inherited enumerable keys (which for..in
visits) write nothing.  So every step of the walk also counts against a work
cap, maxWork (by default max: a member written takes at least 4 bytes, an
element at least 1, so nothing measurable within max needs more), and the
walk gives up when it is used up (LIMIT-H1B2I-2).
*/

// The UTF-8 width of the code unit at i: a valid surrogate pair counts 4 at
// its high half and 0 at its low half; a lone surrogate is returned as -3
// (TextEncoder writes it as U+FFFD, 3 bytes; JSON.stringify escapes it).
// A number, not an object, so counting allocates nothing.
function utf8Width(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = s.charCodeAt(i + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 4 : -3;
  }
  if (c >= 0xdc00 && c <= 0xdfff) {
    const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
    return prev >= 0xd800 && prev <= 0xdbff ? 0 : -3;
  }
  return 3;
}

// UTF-8 length of s, or undefined once it passes max.  (A lone surrogate
// encodes as U+FFFD, 3 bytes, as TextEncoder writes it.)
export function utf8LengthCapped(s: string, max: number): number | undefined {
  if (s.length > max) return undefined;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n += Math.abs(utf8Width(s, i));
    if (n > max) return undefined;
  }
  return n;
}

// The length of JSON.stringify(s) for a string s, in UTF-8 bytes.
function jsonStringLength(s: string, budget: number): number | undefined {
  let n = 2; // the quotes
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) {
      n += 2; // \" and \\
    } else if (
      c === 0x08 ||
      c === 0x0c ||
      c === 0x0a ||
      c === 0x0d ||
      c === 0x09
    ) {
      n += 2; // \b \f \n \r \t
    } else if (c < 0x20) {
      n += 6; // \u00XX
    } else {
      const width = utf8Width(s, i);
      // JSON.stringify escapes a lone surrogate as \udXXX
      n += width < 0 ? 6 : width;
    }
    if (n > budget) return undefined;
  }
  return n;
}

const IMMUTABLE_MAP = "@@__IMMUTABLE_MAP__@@";
const IMMUTABLE_LIST = "@@__IMMUTABLE_LIST__@@";

type Kind = "object" | "array" | "immutable-map" | "immutable-list";

function containerKind(x: object): Kind | undefined {
  if (Array.isArray(x)) return "array";
  const anyx = x as any;
  if (anyx[IMMUTABLE_MAP] === true) return "immutable-map";
  if (anyx[IMMUTABLE_LIST] === true) return "immutable-list";
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return undefined;
  if (typeof anyx.toJSON === "function") return undefined;
  return "object";
}

// thrown when the work cap is used up
class WorkExhausted extends Error {}

// the own enumerable string keys of a plain object, one at a time (never a
// list of all of them); every key for..in visits, own or inherited, is a
// step of work
function* ownKeys(obj: object, tick: () => void): Generator<string> {
  for (const key in obj) {
    tick();
    if (Object.prototype.hasOwnProperty.call(obj, key)) yield key;
  }
}

interface Frame {
  container: object;
  kind: Kind;
  // the entries left, as [key, value] (key undefined in arrays)
  next: () => { done: boolean; key?: string; value?: unknown };
  // whether an element or member was already written (a comma comes next)
  written: boolean;
}

function frameFor(container: object, kind: Kind, tick: () => void): Frame {
  if (kind === "object") {
    const keys = ownKeys(container, tick);
    return {
      container,
      kind,
      written: false,
      next: () => {
        const r = keys.next();
        return r.done
          ? { done: true }
          : { done: false, key: r.value, value: (container as any)[r.value] };
      },
    };
  }
  if (kind === "array") {
    let i = 0;
    const arr = container as unknown[];
    return {
      container,
      kind,
      written: false,
      next: () =>
        i < arr.length ? { done: false, value: arr[i++] } : { done: true },
    };
  }
  if (kind === "immutable-map") {
    const it = (container as any).entries();
    return {
      container,
      kind,
      written: false,
      next: () => {
        const r = it.next();
        return r.done
          ? { done: true }
          : { done: false, key: String(r.value[0]), value: r.value[1] };
      },
    };
  }
  const it = (container as any).values();
  return {
    container,
    kind,
    written: false,
    next: () => {
      const r = it.next();
      return r.done ? { done: true } : { done: false, value: r.value };
    },
  };
}

// omitted in objects, written as null in arrays (as JSON.stringify does)
const isOmitted = (v: unknown) =>
  v === undefined || typeof v === "function" || typeof v === "symbol";

// The length of JSON.stringify(value) in UTF-8 bytes (Immutable Map and List
// counted as their toJS() would be), or undefined if it passes max, nests
// deeper than maxDepth, or holds a value this does not reproduce exactly.
export function jsonLengthCapped(
  value: unknown,
  opts: { max: number; maxDepth?: number; maxWork?: number },
): number | undefined {
  return jsonMeasureCapped(value, opts)?.bytes;
}

// The same, with the work the walk used, so callers measuring many values can
// share one work budget.
export function jsonMeasureCapped(
  value: unknown,
  opts: { max: number; maxDepth?: number; maxWork?: number },
): { bytes: number; work: number } | undefined {
  return measure(value, {
    max: opts.max,
    maxDepth: opts.maxDepth,
    maxWork: opts.maxWork ?? opts.max,
  });
}

function measure(
  value: unknown,
  {
    max,
    maxDepth = 1000,
    maxWork,
  }: { max: number; maxDepth?: number; maxWork: number },
): { bytes: number; work: number } | undefined {
  let work = 0;
  const tick = () => {
    work += 1;
    if (work > maxWork) throw new WorkExhausted();
  };
  try {
    const bytes = walk(value, { max, maxDepth, tick });
    return bytes == null ? undefined : { bytes, work };
  } catch (err) {
    if (err instanceof WorkExhausted) return undefined;
    throw err;
  }
}

function walk(
  value: unknown,
  { max, maxDepth, tick }: { max: number; maxDepth: number; tick: () => void },
): number | undefined {
  let n = 0;
  const over = () => n > max;
  // a scalar's length, or undefined if not supported
  const scalar = (v: unknown): number | undefined => {
    if (v === null) return 4;
    switch (typeof v) {
      case "boolean":
        return v ? 4 : 5;
      case "number":
        return Number.isFinite(v) ? String(v).length : 4; // NaN, ±Infinity: null
      case "string":
        return jsonStringLength(v, max - n);
      default:
        return undefined;
    }
  };
  const stack: Frame[] = [];
  const onStack = new Set<object>();
  // begin a value: a scalar is counted, a container is pushed
  const begin = (v: unknown): boolean => {
    if (v !== null && typeof v === "object") {
      const kind = containerKind(v);
      if (kind == null || onStack.has(v) || stack.length >= maxDepth) {
        return false;
      }
      n += 1; // { or [
      stack.push(frameFor(v, kind, tick));
      onStack.add(v);
      return !over();
    }
    if (typeof v === "bigint") return false;
    const len = scalar(v);
    if (len == null) return false;
    n += len;
    return !over();
  };

  if (isOmitted(value)) return undefined; // JSON.stringify gives undefined
  if (!begin(value)) return undefined;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const entry = frame.next();
    if (entry.done) {
      n += 1; // } or ]
      stack.pop();
      onStack.delete(frame.container);
      if (over()) return undefined;
      continue;
    }
    // a plain object's steps are counted as for..in visits its keys
    if (frame.kind !== "object") tick();
    const isObject = frame.kind === "object" || frame.kind === "immutable-map";
    if (isObject && isOmitted(entry.value)) continue; // member omitted
    if (frame.written) n += 1; // ,
    frame.written = true;
    if (isObject) {
      const keyLength = jsonStringLength(entry.key!, max - n);
      if (keyLength == null) return undefined;
      n += keyLength + 1; // "key":
      if (over()) return undefined;
    }
    if (!isObject && isOmitted(entry.value)) {
      n += 4; // null in an array
      if (over()) return undefined;
      continue;
    }
    if (!begin(entry.value)) return undefined;
  }
  return n;
}

// The length of the records' JSON lines joined by newlines (what a db
// document's to_str() writes), skipping empty slots, or undefined as above.
// One work cap for all the records (each record, even a skipped one, is a
// step).
export function jsonLinesLengthCapped(
  records: Iterable<unknown>,
  {
    max,
    maxDepth,
    maxWork = max,
  }: { max: number; maxDepth?: number; maxWork?: number },
): number | undefined {
  let n = 0;
  let count = 0;
  let work = 0;
  for (const record of records) {
    work += 1;
    if (work > maxWork) return undefined;
    if (record == null) continue;
    if (count > 0) n += 1; // \n
    const result = measure(record, {
      max: max - n,
      maxDepth,
      maxWork: maxWork - work,
    });
    if (result == null) return undefined;
    n += result.bytes;
    work += result.work;
    count += 1;
    if (n > max) return undefined;
  }
  return n;
}
