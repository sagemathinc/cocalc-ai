/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountTable, initAccountRealtime } from "./table";

export function initAccountTable(redux) {
  redux.createTable("account", AccountTable);
  redux.getTable("account")._table.on("error", (tableError) => {
    redux.getActions("account").setState({ tableError });
  });
  redux.getTable("account")._table.on("clear-error", () => {
    redux.getActions("account").setState({ tableError: undefined });
  });
  initAccountRealtime({ redux, recreate_account_table });
}

export function recreate_account_table(redux) {
  redux.removeTable("account");
  initAccountTable(redux);
}
