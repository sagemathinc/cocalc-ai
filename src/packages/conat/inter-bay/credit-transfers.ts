import type {
  CreditTransferApi,
  CreditTransferRecipient,
  CreditTransferManifest,
  CreditTransferDelivery,
  PaymentRoot,
} from "@cocalc/util/credit-transfers";

export interface InterBayCreditTransferApi extends CreditTransferApi {
  creditTransferRecipient: (opts: {
    account_id: string;
  }) => Promise<CreditTransferRecipient>;
  creditTransferVerifyRoot: (opts: {
    account_id: string;
    purchase_id: number;
    root_id?: string;
  }) => Promise<
    | {
        root: PaymentRoot;
        evidence: {
          charge_id: string;
          balance_transaction_id: string;
          available_on: number;
          verified_at: string;
          stripe_site?: string;
        };
      }
    | undefined
  >;
  creditTransferOutgoing: (opts: {
    account_id: string;
    transfer_id: string;
  }) => Promise<CreditTransferManifest>;
  creditTransferDeliver: (opts: {
    sender_home_bay_id: string;
    sender_account_id: string;
    transfer_id: string;
  }) => Promise<CreditTransferDelivery>;
}
