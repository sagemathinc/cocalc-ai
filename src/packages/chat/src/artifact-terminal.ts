/**
 * A live project terminal shown in an artifact card: the terminal session
 * an agent works in (`cocalc project terminal share`), which the human
 * watches and can type into.  `path` is the session id, the same id
 * `cocalc project terminal write|history` take.
 */
export interface ArtifactTerminal {
  path: string;
}

export function validateArtifactTerminal(value: unknown): ArtifactTerminal {
  const row =
    (value as any)?.toJS instanceof Function
      ? (value as any).toJS()
      : (value as ArtifactTerminal);
  const path = row?.path;
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.length > 1024 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(path)
  )
    throw Error("invalid artifact terminal path");
  return { path };
}
