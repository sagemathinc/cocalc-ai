/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tag } from "antd";

export type AccountStatusInfo = {
  banned?: boolean | null;
  membership_class?: string | null;
  membership_label?: string | null;
  membership_source?: string | null;
};

export function AccountStatusTags({ account }: { account: AccountStatusInfo }) {
  const membershipClass = `${account.membership_class ?? ""}`.trim();
  const membershipLabel =
    `${account.membership_label ?? ""}`.trim() ||
    (membershipClass === "free" ? "Free" : membershipClass);

  return (
    <>
      {account.banned ? <Tag color="red">Banned</Tag> : null}
      {membershipClass ? (
        <Tag
          color={membershipClass === "free" ? "default" : "blue"}
          title={`Membership: ${membershipClass}${
            account.membership_source ? ` (${account.membership_source})` : ""
          }`}
        >
          {membershipLabel}
        </Tag>
      ) : null}
    </>
  );
}
