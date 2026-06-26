/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon } from "@cocalc/frontend/components/icon";
import { redux, useMemo, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { timestamp_cmp, trunc_middle } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  ALL_PROJECT_COLLABORATORS_MENTION_ID,
  getMentionAllAccountIds,
} from "./mention-all";
import type { Item } from "./complete";

interface Opts {
  avatarUserSize?: number;
  avatarLLMSize?: number;
}

export function useMentionableUsers(): (
  search: string | undefined,
  opts?: Opts,
) => Item[] {
  const { project_id } = useProjectContext();
  const user_map = useTypedRedux("users", "user_map");

  return useMemo(() => {
    return (search: string | undefined, opts?: Opts) => {
      return mentionableUsers({
        search,
        project_id,
        opts,
      });
    };
  }, [project_id, user_map]);
}

interface Props {
  search: string | undefined;
  project_id: string;
  opts?: Opts;
}

export function mentionableUsers({ search, project_id, opts }: Props): Item[] {
  const { avatarUserSize = 24 } = opts ?? {};

  const users = redux
    .getStore("projects")
    .getIn(["project_map", project_id, "users"]);

  const last_active = redux
    .getStore("projects")
    .getIn(["project_map", project_id, "last_active"]);

  const my_account_id = redux.getStore("account")?.get("account_id");

  const projectUsers: {
    account_id: string;
    last_active: Date | undefined;
  }[] = [];
  for (const [account_id] of users ?? []) {
    projectUsers.push({
      account_id,
      last_active: last_active?.get(account_id),
    });
  }
  projectUsers.sort((a, b) => {
    if (a.account_id === my_account_id) {
      return 1;
    }
    if (b.account_id === my_account_id) {
      return -1;
    }
    return timestamp_cmp(a, b, "last_active");
  });

  const usersStore = redux.getStore("users");
  const mentions: Item[] = [];
  if (getMentionAllAccountIds(project_id).length > 0) {
    mentions.push({
      value: ALL_PROJECT_COLLABORATORS_MENTION_ID,
      label: (
        <span>
          <Icon name="users" style={{ color: COLORS.GRAY_M }} /> All
          collaborators
        </span>
      ),
      search: "all collaborators everyone everybody",
    });
  }

  for (const { account_id } of projectUsers) {
    const fullname = usersStore.get_name(account_id)?.trim();
    if (!fullname) {
      continue;
    }
    const searchText = fullname.toLowerCase();
    if (search != null && searchText.indexOf(search) === -1) continue;
    mentions.push({
      value: account_id,
      label: (
        <span>
          <Avatar account_id={account_id} size={avatarUserSize} />{" "}
          {trunc_middle(fullname, 64)}
        </span>
      ),
      search: searchText,
    });
  }

  return mentions;
}
