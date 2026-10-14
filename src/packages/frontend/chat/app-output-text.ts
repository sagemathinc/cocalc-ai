/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A project app's captured stdout or stderr is a Buffer on the project.  Over
// conat it arrives in the browser as a Uint8Array (or, from older paths, as a
// JSON-encoded Buffer), and interpolating that into a string shows a list of
// byte values instead of the text.

/** The text of an app's captured output, however it was encoded. */
export function appOutputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  // Not instanceof: bytes can come from another realm (a worker, jsdom).
  if (ArrayBuffer.isView(output)) {
    return decode(
      new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
    );
  }
  if (Object.prototype.toString.call(output) === "[object ArrayBuffer]") {
    return decode(new Uint8Array(output as ArrayBuffer));
  }
  const { type, data } = output as { type?: unknown; data?: unknown };
  if (type === "Buffer" && Array.isArray(data)) {
    return decode(Uint8Array.from(data));
  }
  return `${output}`;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
