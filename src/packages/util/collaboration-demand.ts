/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
export type CollaborationDemandScope =
  | { kind: "all" }
  | { kind: "projects"; project_ids: string[] };
export interface CollaborationDemandReceipt {
  consumer_id: string;
  lease_id: string;
  scope: CollaborationDemandScope;
  expires_at: number;
  renew_after: number;
}
export interface CollaborationDemandState {
  state: "active" | "grace" | "cold";
  active_consumers: number;
  scope: CollaborationDemandScope | null;
}
export interface CollaborationDemandApi {
  acquireDemand(opts: {
    account_id?: string;
    consumer_id: string;
    scope: CollaborationDemandScope;
  }): Promise<CollaborationDemandReceipt>;
  renewDemand(opts: {
    account_id?: string;
    consumer_id: string;
    lease_id: string;
  }): Promise<CollaborationDemandReceipt & { renewed: boolean }>;
  releaseDemand(opts: {
    account_id?: string;
    consumer_id: string;
    lease_id: string;
  }): Promise<{ released: boolean }>;
  inspectDemand(opts: {
    account_id?: string;
  }): Promise<CollaborationDemandState>;
}
