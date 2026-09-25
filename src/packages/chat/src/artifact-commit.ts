/** Branch is context only; review always uses the immutable full SHA. */
export interface ArtifactCommit {
  sha: string;
  path: string;
  common_directory: string;
  branch?: string;
}
export function validateArtifactCommit(value: unknown): ArtifactCommit {
  const row = value as ArtifactCommit;
  if (!row || typeof row.sha !== "string" || !/^[a-f0-9]{40}$/.test(row.sha))
    throw Error("commit artifact requires a full SHA");
  for (const path of [row.path, row.common_directory]) {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.length > 4096 ||
      /[\x00-\x1f\x7f\\]/.test(path) ||
      path.split("/").includes("..")
    )
      throw Error("invalid commit repository path");
  }
  if (
    row.branch !== undefined &&
    (typeof row.branch !== "string" ||
      row.branch.length > 256 ||
      /[\x00-\x1f\x7f]/.test(row.branch))
  )
    throw Error("invalid commit branch label");
  return {
    sha: row.sha,
    path: row.path,
    common_directory: row.common_directory,
    ...(row.branch === undefined ? {} : { branch: row.branch }),
  };
}
