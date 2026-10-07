/**
 * A project app shown live in an artifact card, through the project's
 * authenticated app proxy (e.g. the shared browser that an agent and a human
 * use together).  The card resolves the app's URL when it is displayed.
 */
export interface ArtifactApp {
  id: string;
}

// Same as project app spec ids.
const APP_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/i;

export function validateArtifactApp(value: unknown): ArtifactApp {
  const row = (value as any)?.toJS instanceof Function
    ? (value as any).toJS()
    : (value as ArtifactApp);
  if (!row || typeof row.id !== "string" || !APP_ID_RE.test(row.id))
    throw Error("invalid artifact app id");
  return { id: row.id };
}
