// A lazy concatenation lets the renderer select a small part without allocating
// a second copy of an entire turn. Full materialization is reserved for export.
export interface TextSource {
  length: number;
  slice: (start: number, end: number) => string;
  toString: () => string;
  // Optional display-only body ranges. Copy/export still use the source above.
  rendering?: {
    source: TextSource;
    ranges: TextSourceRange[];
    // Each formatted range is at most maxExpansion * body.length + maxOverhead.
    maxExpansion: number;
    maxOverhead: number;
  };
}

export interface TextSourceRange {
  start: number;
  end: number;
  format?: (part: string) => string;
}

export function joinedTextSource(parts: string[]): TextSource {
  return {
    length: parts.reduce((length, part) => length + part.length, 0),
    slice(start, end) {
      const result: string[] = [];
      let offset = 0;
      for (const part of parts) {
        if (offset >= end) break;
        if (offset + part.length > start) {
          result.push(part.slice(Math.max(0, start - offset), end - offset));
        }
        offset += part.length;
      }
      return result.join("");
    },
    toString: () => parts.join(""),
  };
}
