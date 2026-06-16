/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import api from "@cocalc/frontend/client/api";
import type { MembershipTierWithPresentation } from "./membership-tier-benefits";

export interface MembershipTierLike extends MembershipTierWithPresentation {
  id: string;
  label?: string;
  price_monthly?: number;
  price_yearly?: number;
  priority?: number;
  store_visible?: boolean;
  team_visible?: boolean;
  disabled?: boolean;
  site_license_pool_description?: string;
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: Record<string, unknown>;
}

interface MembershipTiersResponse {
  error?: string;
  tiers?: MembershipTierLike[];
}

export function useMembershipTiers() {
  const [tiers, setTiers] = useState<MembershipTierLike[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);

  useEffect(() => {
    let canceled = false;

    async function loadTiers() {
      setLoading(true);
      setError("");
      try {
        const result = (await api(
          "purchases/get-membership-tiers",
        )) as MembershipTiersResponse;
        if (result?.error) {
          throw Error(result.error);
        }
        if (!canceled) {
          setTiers(result?.tiers ?? []);
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
          setTiers([]);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }

    void loadTiers();
    return () => {
      canceled = true;
    };
  }, [refreshToken]);

  return {
    error,
    loading,
    refresh: () => setRefreshToken((value) => value + 1),
    tiers,
  };
}
