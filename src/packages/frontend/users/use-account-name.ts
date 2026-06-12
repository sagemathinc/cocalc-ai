import { useEffect, useState } from "react";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { webapp_client } from "../webapp-client";

interface AccountName {
  displayName: string;
  firstName: string;
  lastName: string;
}

export default function useAccountName(account_id: string): AccountName | null {
  const [name, setName] = useState<AccountName | null>(null);
  useEffect(() => {
    (async () => {
      let user;
      try {
        user = await webapp_client.users_client.get_username(account_id);
      } catch (_err) {
        // TODO -- could have some sort of retry?
        return;
      }
      const { first_name: firstName, last_name: lastName } = user;
      setName({
        displayName: displayNameFromAccount(user),
        firstName,
        lastName,
      });
    })();
  }, [account_id]);

  return name;
}
