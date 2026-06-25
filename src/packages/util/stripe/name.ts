import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { trunc_middle } from "@cocalc/util/misc";

export default function stripeName(account: {
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  return trunc_middle(displayNameFromAccount(account), 200);
}
