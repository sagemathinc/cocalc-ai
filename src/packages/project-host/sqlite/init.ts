import {
  getRow,
  initDatabase,
  upsertRow,
} from "@cocalc/lite/hub/sqlite/database";
import { account_id } from "@cocalc/backend/data";
import { clearActiveStorageReservations } from "../storage-reservations";

export function initSqlite() {
  initDatabase();
  clearActiveStorageReservations();
  ensureAccountRow();
}

function ensureAccountRow() {
  const pk = JSON.stringify({ account_id });
  const existing = getRow("accounts", pk);
  if (existing) return;
  upsertRow("accounts", pk, {
    account_id,
    email_address: "user@cocalc.com",
  });
}
