export const COCALC_TERMINAL_OPEN_OSC = 7777;
export const COCALC_TERMINAL_OPEN_OSC_ENV = "COCALC_TERMINAL_OPEN_OSC";

export interface TerminalOpenPathFile {
  file: string;
}

export interface TerminalOpenPathDirectory {
  directory: string;
}

export type TerminalOpenPath = TerminalOpenPathFile | TerminalOpenPathDirectory;

export interface TerminalOpenMessage {
  event: "open";
  paths: TerminalOpenPath[];
}

function isTerminalOpenPath(path: unknown): path is TerminalOpenPath {
  if (path == null || typeof path !== "object") {
    return false;
  }
  const obj = path as Record<string, unknown>;
  return typeof obj.file === "string" || typeof obj.directory === "string";
}

export function isTerminalOpenMessage(
  message: unknown,
): message is TerminalOpenMessage {
  if (message == null || typeof message !== "object") {
    return false;
  }
  const obj = message as Record<string, unknown>;
  return (
    obj.event === "open" &&
    Array.isArray(obj.paths) &&
    obj.paths.every(isTerminalOpenPath)
  );
}

export function encodeTerminalOpenMessage(
  message: TerminalOpenMessage,
): string {
  return encodeURIComponent(JSON.stringify(message));
}

export function decodeTerminalOpenMessage(
  payload: string,
): TerminalOpenMessage | undefined {
  try {
    const message = JSON.parse(decodeURIComponent(payload));
    return isTerminalOpenMessage(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

export function makeTerminalOpenOsc(message: TerminalOpenMessage): string {
  return `\x1b]${COCALC_TERMINAL_OPEN_OSC};${encodeTerminalOpenMessage(message)}\x07`;
}
