/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";
import { type ReactElement, useEffect, useState } from "react";

import {
  useAccountOtherSetting,
  useAsyncEffect,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import api from "@cocalc/frontend/client/api";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { Tooltip } from "@cocalc/frontend/components";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { capitalize } from "@cocalc/util/misc";
import { HIDE_NAVBAR_MEMBERSHIP_SETTING } from "./navbar-membership-setting";

interface MembershipTier {
  id: string;
  label?: string;
}

interface MembershipTiersResponse {
  tiers?: MembershipTier[];
}

interface MembershipBadgeData {
  accountId: string;
  membership: MembershipResolution;
  tiers: MembershipTier[];
}

export default function MembershipBadge({
  alwaysShowFree = false,
}: {
  alwaysShowFree?: boolean;
} = {}): ReactElement | null {
  const accountId = useTypedRedux("account", "account_id");
  const hidden =
    useAccountOtherSetting<boolean>(HIDE_NAVBAR_MEMBERSHIP_SETTING) ?? false;
  const [data, setData] = useState<MembershipBadgeData>();
  const [refreshToken, setRefreshToken] = useState<number>(0);

  useAsyncEffect(
    async (isMounted) => {
      if (!accountId || (hidden && !alwaysShowFree)) {
        setData(undefined);
        return;
      }
      try {
        const [membership, tiersResult] = await Promise.all([
          api("purchases/get-membership"),
          api("purchases/get-membership-tiers"),
        ]);
        if (!isMounted()) return;
        setData({
          accountId,
          membership: membership as MembershipResolution,
          tiers: (tiersResult as MembershipTiersResponse)?.tiers ?? [],
        });
      } catch {
        if (isMounted()) {
          setData(undefined);
        }
      }
    },
    [accountId, alwaysShowFree, hidden, refreshToken],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => setRefreshToken((value) => value + 1);
    window.addEventListener("cocalc:membership-changed", refresh);
    return () => {
      window.removeEventListener("cocalc:membership-changed", refresh);
    };
  }, []);

  if (!accountId || data?.accountId !== accountId) {
    return null;
  }

  const membershipClass = data.membership.class;
  if (hidden && membershipClass !== "free") {
    return null;
  }
  const tierLabel =
    data.tiers.find(({ id }) => id === membershipClass)?.label ??
    capitalize(membershipClass);
  const actionDescription = "View details and change plans.";
  const description = `Current membership: ${tierLabel}. ${actionDescription}`;

  return (
    <Tooltip
      title={
        <>
          <div>Current membership: {tierLabel}</div>
          <div>{actionDescription}</div>
        </>
      }
      placement="bottom"
    >
      <Button
        aria-label={description}
        color="default"
        onClick={() => openAccountSettings({ page: "membership" })}
        size="small"
        variant="filled"
        style={{
          marginInline: 4,
          maxWidth: 120,
        }}
      >
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {tierLabel}
        </span>
      </Button>
    </Tooltip>
  );
}
