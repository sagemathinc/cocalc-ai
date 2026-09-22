/*
Normal sign-in opens Agents. Explicit URL targets are loaded separately before
this fallback action; project access and execution restrictions still apply.
*/

import { delay } from "awaiting";
import { redux } from "@cocalc/frontend/app-framework";
import { once } from "@cocalc/util/async-utils";
import { QueryParams } from "@cocalc/frontend/misc/query-params";

export default async function signInAction() {
  if (QueryParams.get("sign-in") == null) return;
  QueryParams.remove("sign-in");
  await delay(1);
  const account = redux.getStore("account");
  while (account.get("created") == null) {
    await once(account, "change");
  }
  await redux.getActions("page").set_active_tab("agents");
}
