import type { Service } from "@cocalc/util/db-schema/purchases";
import * as purchasesApi from "@cocalc/frontend/purchases/api";
import type { MoneyValue } from "@cocalc/util/money";
import type { WebappClient } from "./client";

export class PurchasesClient {
  api: typeof purchasesApi;
  client: WebappClient;

  constructor(client: WebappClient) {
    this.api = purchasesApi;
    this.client = client;
  }
  async getBalance(): Promise<MoneyValue> {
    return await this.client.conat_client.hub.purchases.getBalance();
  }

  async isPurchaseAllowed(
    service: Service,
    cost?: MoneyValue,
  ): Promise<{ allowed: boolean; reason?: string; chargeAmount?: number }> {
    return await purchasesApi.isPurchaseAllowed(service, cost);
  }

  async getPurchases(opts: {
    thisMonth?: boolean; // if true, limit and offset are ignored
    limit?: number;
    offset?: number;
    service?: Service;
    project_id?: string;
    group?: boolean;
  }) {
    return await purchasesApi.getPurchases(opts);
  }

  async getInvoice(invoice_id: string) {
    return await purchasesApi.getInvoice(invoice_id);
  }

  async getCostPerDay(opts: { limit?: number; offset?: number }) {
    return await purchasesApi.getCostPerDay(opts);
  }

  async getCustomer() {
    return await purchasesApi.getCustomer();
  }

  async getChargesByService(): Promise<{ [service: string]: MoneyValue }> {
    return await purchasesApi.getChargesByService();
  }

  async getUnpaidInvoices(): Promise<any[]> {
    return await purchasesApi.getUnpaidInvoices();
  }

  async getServiceCost(service: Service): Promise<any> {
    return await purchasesApi.getServiceCost(service);
  }

  async getMinimumPayment(): Promise<number> {
    return await purchasesApi.getMinimumPayment();
  }

  async adminGetMinBalance(account_id: string): Promise<MoneyValue> {
    return await purchasesApi.adminGetMinBalance(account_id);
  }

  async adminSetMinBalance(account_id: string, minBalance: number) {
    await purchasesApi.adminSetMinBalance(account_id, minBalance);
  }

  async renewSubscription(
    subscription_id: number,
  ): Promise<{ purchase_id: number | null }> {
    return await purchasesApi.renewSubscription(subscription_id);
  }

  async getLiveSubscriptions() {
    return await purchasesApi.getLiveSubscriptions();
  }
}
