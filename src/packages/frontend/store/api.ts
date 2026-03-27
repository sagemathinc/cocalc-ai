/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import api from "@cocalc/frontend/client/api";
import type { Voucher, VoucherCode } from "@cocalc/util/db-schema/vouchers";

export async function createVoucherPurchase(opts: {
  amount: number;
  count: number;
  title: string;
}): Promise<{ amount: number; codes: string[]; id: number }> {
  return await api("vouchers/create", opts);
}

export async function adminPurchase(opts: {
  comment?: string;
  interval?: "month" | "year";
  membership_class?: string;
  price: number;
  pricing_note?: string;
  product: "membership" | "voucher";
  source: "credit" | "free";
  user_account_id: string;
  voucher_amount?: number;
  voucher_count?: number;
  voucher_title?: string;
}): Promise<{
  purchase_id: number;
  credit_id?: number;
  expires_at?: Date | null;
  voucher_codes?: string[];
  voucher_id?: number;
}> {
  return await api("purchases/admin-purchase", opts);
}

export async function getVoucherCenterData(): Promise<{
  created: Voucher[];
  redeemed: VoucherCode[];
}> {
  const [vouchersResult, voucherCodesResult] = await Promise.all([
    api("user-query", {
      query: {
        vouchers: [
          {
            active: null,
            count: null,
            cost: null,
            created: null,
            expire: null,
            id: null,
            purchased: null,
            title: null,
            when_pay: null,
          },
        ],
      },
    }),
    api("user-query", {
      query: {
        voucher_codes: [
          {
            canceled: null,
            code: null,
            created: null,
            id: null,
            purchase_ids: null,
            redeemed_by: null,
            when_redeemed: null,
          },
        ],
      },
    }),
  ]);
  return {
    created: vouchersResult?.query?.vouchers ?? [],
    redeemed: voucherCodesResult?.query?.voucher_codes ?? [],
  };
}

export async function getAdminVouchers(): Promise<Voucher[]> {
  const result = await api("user-query", {
    query: {
      crm_vouchers: [
        {
          active: null,
          cancel_by: null,
          cost: null,
          count: null,
          created: null,
          created_by: null,
          expire: null,
          id: null,
          notes: null,
          purchased: null,
          title: null,
          when_pay: null,
        },
      ],
    },
  });
  return result?.query?.crm_vouchers ?? [];
}

export async function getVoucherCodes(
  id: string | number,
): Promise<VoucherCode[]> {
  const result = await api("vouchers/get-voucher-codes", { id });
  return result?.codes ?? [];
}

export async function setVoucherCodeNotes(code: string, notes: string) {
  await api("vouchers/set-voucher-code-notes", { code, notes });
}

export async function chargeForUnpaidVouchers(): Promise<any> {
  return await api("vouchers/charge-for-unpaid-vouchers");
}
