import api from "@cocalc/frontend/client/api";

export async function adminPurchase(opts: {
  user_account_id: string;
  product: "membership" | "voucher";
  source: "credit" | "free";
  price: number;
  pricing_note?: string;
  comment?: string;
  membership_class?: string;
  interval?: "month" | "year";
  voucher_amount?: number;
  voucher_count?: number;
  voucher_title?: string;
}): Promise<{
  purchase_id: number;
  credit_id?: number;
  voucher_codes?: string[];
  voucher_id?: string;
  expires_at?: Date | null;
}> {
  return await api("purchases/admin-purchase", opts);
}
