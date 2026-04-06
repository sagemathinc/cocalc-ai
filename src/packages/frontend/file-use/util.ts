/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { delay } from "awaiting";
import { redux } from "@cocalc/frontend/app-framework";

export async function open_file_use_entry(
  project_id: string,
  path: string,
  show_chat: boolean,
): Promise<void> {
  // Start the project opening. This may trigger a session restore.
  redux.getActions("projects").open_project({ project_id, switch_to: true });
  // Now open the file.
  const a = redux.getProjectActions(project_id);
  if (a == null) return;
  // We wait until the next render loop before actually opening
  // the file.  The reason is because opening the project restores
  // the session, and if this file is opened as part of that session
  // it gets opened with the wrong options (e.g., without chat and
  // not foreground).  Session restore open is really just setting
  // some react state, hence we just have to wait until the next
  // loop.
  // TODO: this needs to be fixed by making open_project work
  // properly and have a chat option!
  await delay(0);
  a.open_file({
    path: path,
    foreground: true,
    foreground_project: true,
    chat: show_chat,
  });
}
