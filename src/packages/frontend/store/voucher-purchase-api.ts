import api from "@cocalc/frontend/client/api";

export async function createVoucherPurchase(opts: {
  amount: number;
  count: number;
  title: string;
}): Promise<{ id: string; codes: string[]; amount: number }> {
  return await api("vouchers/create", opts);
}
