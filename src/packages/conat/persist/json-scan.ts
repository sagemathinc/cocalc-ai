/*
Is a string one JSON object per non-empty line (a board document, as the
immer db writes it)? Decided by scanning, never by parsing: nothing is
built, so the check costs one pass over the text and no heap however its
values are shaped (daybreak2, #1236 round 12: JSON.parse of a 7 MiB line
of tiny members took about 220 ms and 90 MiB). Accepts exactly what
`JSON.parse(line)` accepts as an object, except that containers may nest
at most maxDepth deep and whitespace runs at most MAX_WHITESPACE_RUN long.
*/

export const DOCUMENT_MAX_DEPTH = 64;
// A board document is compact JSON (JSON.stringify of each record), so a
// longer run of whitespace is refused: then no single step but a string's
// or a number's is longer than a slice (whitespace scans slowest).
export const MAX_WHITESPACE_RUN = 4096;

const SPACE = 32;
const TAB = 9;
const CR = 13;
const LF = 10;
const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const COLON = 58;
const MINUS = 45;
const PLUS = 43;
const DOT = 46;
const ZERO = 48;
const NINE = 57;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;

export function isJsonObjectLines(
  text: string,
  maxDepth: number = DOCUMENT_MAX_DEPTH,
): boolean {
  return new DocumentScan(text, maxDepth).step(Infinity)!;
}

// The same, a slice at a time, yielding to the event loop between slices:
// so even an adversarial 7 MiB document never holds the loop for more than
// a slice's scan (a few ms; the slow shapes run about 13 ns a character).
export async function isJsonObjectLinesAsync(
  text: string,
  {
    maxDepth = DOCUMENT_MAX_DEPTH,
    sliceChars = DOCUMENT_SLICE_CHARS,
  }: { maxDepth?: number; sliceChars?: number } = {},
): Promise<boolean> {
  const scan = new DocumentScan(text, maxDepth);
  for (;;) {
    const verdict = scan.step(sliceChars);
    if (verdict !== undefined) return verdict;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export const DOCUMENT_SLICE_CHARS = 256 * 1024;

const OBJECT = 1;
const ARRAY = 2;

const AT_LINE = 0;
const AT_VALUE = 1;
const AFTER_VALUE = 2;

/*
A resumable scan: step(chars) reads on for about that many more characters
(it stops between values, so a single string or number may run over) and
returns the verdict once it is known. Iterative, so a value costs no call
and nesting no stack frames: the open containers are in stack.
*/
export class DocumentScan {
  private readonly text: string;
  private readonly stack: Uint8Array;
  private i = 0;
  private sp = 0;
  private phase = AT_LINE;
  private verdict?: boolean;

  constructor(text: string, maxDepth: number = DOCUMENT_MAX_DEPTH) {
    this.text = text;
    this.stack = new Uint8Array(maxDepth);
  }

  step(chars: number): boolean | undefined {
    if (this.verdict !== undefined) return this.verdict;
    const s = this.text;
    const n = s.length;
    const stack = this.stack;
    const stop = this.i + chars;
    let { i, sp, phase } = this;
    const done = (verdict: boolean) => (this.verdict = verdict);
    for (;;) {
      if (phase === AT_LINE) {
        if (i >= n) return done(true);
        if (i >= stop) break;
        // An empty line is skipped (only an empty one: a line of just
        // whitespace is no JSON).
        if (s.charCodeAt(i) === LF) {
          i += 1;
          continue;
        }
        i = ws(s, i);
        if (s.charCodeAt(i) !== OPEN_BRACE) return done(false);
        phase = AT_VALUE;
        sp = 0;
        continue;
      }
      if (phase === AT_VALUE) {
        if (i >= stop && i < n) break;
        const c = s.charCodeAt(i);
        if (c === OPEN_BRACE || c === OPEN_BRACKET) {
          if (sp >= stack.length) return done(false);
          i = ws(s, i + 1);
          const d = s.charCodeAt(i);
          if (c === OPEN_BRACE) {
            if (d === CLOSE_BRACE) {
              i += 1;
            } else {
              stack[sp++] = OBJECT;
              i = key(s, i);
              if (i < 0) return done(false);
              continue;
            }
          } else if (d === CLOSE_BRACKET) {
            i += 1;
          } else {
            stack[sp++] = ARRAY;
            continue;
          }
        } else if (c === QUOTE) {
          i = string(s, i);
        } else if (c === MINUS || (c >= ZERO && c <= NINE)) {
          i = number(s, i);
        } else if (c === 116 /* t */ && s.startsWith("true", i)) {
          i += 4;
        } else if (c === 102 /* f */ && s.startsWith("false", i)) {
          i += 5;
        } else if (c === 110 /* n */ && s.startsWith("null", i)) {
          i += 4;
        } else {
          return done(false);
        }
        if (i < 0) return done(false);
        phase = AFTER_VALUE;
      }
      // After a value: a comma, or the ends of containers, or the line's.
      i = ws(s, i);
      if (sp === 0) {
        if (i < n) {
          if (s.charCodeAt(i) !== LF) return done(false);
          i += 1;
        }
        phase = AT_LINE;
        continue;
      }
      const c = s.charCodeAt(i);
      const top = stack[sp - 1];
      if (c === COMMA) {
        i = ws(s, i + 1);
        if (top === OBJECT) {
          i = key(s, i);
          if (i < 0) return done(false);
        }
        phase = AT_VALUE;
        continue;
      }
      if (c === (top === OBJECT ? CLOSE_BRACE : CLOSE_BRACKET)) {
        sp -= 1;
        i += 1;
        continue;
      }
      return done(false);
    }
    this.i = i;
    this.sp = sp;
    this.phase = phase;
    return undefined;
  }
}

// A member's key and its colon, at i: the index of its value, or -1.
function key(s: string, i: number): number {
  if (s.charCodeAt(i) !== QUOTE) return -1;
  i = string(s, i);
  if (i < 0) return -1;
  i = ws(s, i);
  if (s.charCodeAt(i) !== COLON) return -1;
  return ws(s, i + 1);
}

// JSON whitespace within a line (a line feed ends the line), at most
// MAX_WHITESPACE_RUN of it: -1 past that (which every caller then refuses,
// as no character is at -1).
function ws(s: string, i: number): number {
  const limit = i + MAX_WHITESPACE_RUN;
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === SPACE || c === TAB || c === CR) {
      i += 1;
      if (i > limit) return -1;
    } else return i;
  }
}

const isHex = (c: number) =>
  (c >= ZERO && c <= NINE) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function string(s: string, i: number): number {
  i += 1;
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === QUOTE) return i + 1;
    // A control character (or the end: NaN) can't be in a string.
    if (!(c >= SPACE)) return -1;
    if (c === BACKSLASH) {
      const e = s.charCodeAt(i + 1);
      if (e === 117 /* u */) {
        for (let k = 2; k < 6; k++) {
          if (!isHex(s.charCodeAt(i + k))) return -1;
        }
        i += 6;
        continue;
      }
      // " \ / b f n r t
      if (
        e !== QUOTE &&
        e !== BACKSLASH &&
        e !== 47 &&
        e !== 98 &&
        e !== 102 &&
        e !== 110 &&
        e !== 114 &&
        e !== 116
      ) {
        return -1;
      }
      i += 2;
      continue;
    }
    i += 1;
  }
}

const isDigit = (c: number) => c >= ZERO && c <= NINE;

function number(s: string, i: number): number {
  if (s.charCodeAt(i) === MINUS) i += 1;
  const first = s.charCodeAt(i);
  if (first === ZERO) i += 1;
  else if (isDigit(first)) {
    while (isDigit(s.charCodeAt(i))) i += 1;
  } else return -1;
  if (s.charCodeAt(i) === DOT) {
    i += 1;
    if (!isDigit(s.charCodeAt(i))) return -1;
    while (isDigit(s.charCodeAt(i))) i += 1;
  }
  const e = s.charCodeAt(i);
  if (e === 101 || e === 69) {
    i += 1;
    const sign = s.charCodeAt(i);
    if (sign === PLUS || sign === MINUS) i += 1;
    if (!isDigit(s.charCodeAt(i))) return -1;
    while (isDigit(s.charCodeAt(i))) i += 1;
  }
  return i;
}
