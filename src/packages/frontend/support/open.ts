import { redux } from "@cocalc/frontend/app-framework";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { open_new_tab as openNewTab } from "@cocalc/frontend/misc/open-browser-tab";
import getURL from "./url";
import type { Options } from "./url";

export default function openSupportTab(options: Options = {}) {
  const pageActions = redux.getActions("page");
  const accountStore = redux.getStore("account");
  if (pageActions == null || !accountStore?.get("is_logged_in")) {
    // Note that this is a 2K limit on URL lengths, so the body had better not be too large.
    openNewTab(getURL(options));
    return;
  }
  pageActions.setState({ supportModalOptions: options });
  void pageActions.settings("support-ticket");
}

export function openSupportTicketsPage(): void {
  redux.getActions("page")?.settings("");
  openAccountSettings({ kind: "tab", page: "support" });
}
