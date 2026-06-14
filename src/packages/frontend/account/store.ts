/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { make_valid_name } from "@cocalc/util/misc";
import { Store } from "@cocalc/util/redux/Store";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import type { AccountState } from "./types";

// Define account store
export class AccountStore extends Store<AccountState> {
  // User type
  //   - 'public'     : user is not signed in at all, and not trying to sign in
  //   - 'signing_in' : user is currently waiting to see if sign-in attempt will succeed
  //   - 'signed_in'  : user has successfully authenticated and has an id
  constructor(name, redux) {
    super(name, redux);
    this.setup_selectors();
  }

  get_user_type(): string {
    return this.get("user_type");
  }

  get_account_id(): string {
    return this.get("account_id");
  }

  selectors = {
    is_admin: {
      fn: () => {
        const groups = this.get("groups");
        return !!groups && groups.includes("admin");
      },
      dependencies: ["groups"] as const,
    },
  };

  get_terminal_settings(): { [key: string]: any } | undefined {
    return this.get("terminal") ? this.get("terminal").toJS() : undefined;
  }

  get_editor_settings(): { [key: string]: any } | undefined {
    return this.get("editor_settings")
      ? this.get("editor_settings").toJS()
      : undefined;
  }

  get_fullname(): string {
    return (
      displayNameFromAccount({
        display_name: this.get("display_name"),
        first_name: this.get("first_name"),
        last_name: this.get("last_name"),
      }) || "Anonymous"
    );
  }

  get_first_name(): string {
    return this.get("display_name") || this.get("first_name", "Anonymous");
  }

  get_color(): string {
    return this.getIn(
      ["profile", "color"],
      this.get("account_id", "f00").slice(0, 6),
    );
  }

  get_username(): string {
    return make_valid_name(this.get_fullname());
  }

  get_email_address(): string | undefined {
    return this.get("email_address");
  }

  get_confirm_close(): string {
    return this.getIn(["other_settings", "confirm_close"]);
  }

  get_page_size(): number {
    return this.getIn(["other_settings", "page_size"], 500);
  }

  isTourDone(tour: string): boolean {
    const tours = this.get("tours");
    if (!tours) return false;
    return tours.includes(tour) || tours.includes("all");
  }

  showSymbolBarLabels(): boolean {
    return this.getIn(["other_settings", "show_symbol_bar_labels"], false);
  }
}
