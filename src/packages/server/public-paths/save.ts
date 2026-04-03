import getPool from "@cocalc/database/pool";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";

// This sets the last_edited field of the public path to now.  In Kucalc
// that triggers manage-share to copy the files over to the NFS volume
// with the shared files.  In cocalc-docker and dev mode, this doesn't
// trigger anything, since files are served directly from the project, so
// there is no notion of saving them.
//
// TODO: we definitely plan to change cocalc-docker to have
// a separate location for published files, just like kucalc, since then
// you an be sure your files are correct before publishing them, rather than
// having intermediate files available as you go.
//
export default async function savePublicPath(
  public_path_id: string,
  account_id: string,
): Promise<void> {
  const pool = getPool();

  // figure out project_id and make sure account_id is a collab.
  const { rows } = await pool.query(
    "SELECT project_id FROM public_paths WHERE id=$1",
    [public_path_id],
  );
  if (rows.length == 0) {
    throw Error(`no public path with id=${public_path_id}`);
  }

  await assertLocalProjectCollaborator({
    account_id,
    project_id: rows[0].project_id,
  });

  // finally, actually update last_edited.
  await pool.query("UPDATE public_paths SET last_edited = NOW() WHERE id=$1", [
    public_path_id,
  ]);
}
