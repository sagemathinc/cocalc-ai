/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { lockAccountSpending } from "../lock-account-spending";
import {
  lockAccountRehomeFence,
  assertAccountNotRehoming,
} from "@cocalc/database/postgres/account-rehome-fence";
import { lockFundingAuthority } from "@cocalc/server/compute/funding/authority";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { canonicalFundingTerms } from "@cocalc/server/compute/funding/approvals";
import { fundingId } from "@cocalc/util/compute-funding";
import {
  normalizeCreditTransferTerms,
  CREDIT_TRANSFER_DAILY_MAX_USD,
} from "@cocalc/util/credit-transfers";
import type {
  CreditFragment,
  CreditTransferManifest,
  CreditTransferRecipient,
  CreditTransferTerms,
  CreditTransferReceipt,
  CreditTransferDelivery,
} from "@cocalc/util/credit-transfers";
import { toDecimal } from "@cocalc/util/money";
import getSpendableBalance from "../get-spendable-balance";
import createPurchase from "../create-purchase";
import { readCreditLots, importVerifiedPaymentRoots } from "./ledger";
import { selectCreditFragments } from "./provenance";
import { verifyPaymentPurchase } from "./payment-verification";
import type { VerifiedPaymentRoot } from "./payment-verification";

export interface CreditTransferTransport {
  recipient(bay: string, account_id: string): Promise<CreditTransferRecipient>;
  verifyRoot(
    bay: string,
    account_id: string,
    purchase_id: number,
    root_id?: string,
  ): Promise<VerifiedPaymentRoot | undefined>;
  outgoing(
    bay: string,
    account_id: string,
    transfer_id: string,
  ): Promise<CreditTransferManifest>;
  deliver(
    bay: string,
    manifest: Pick<
      CreditTransferManifest,
      "sender_home_bay_id" | "sender_account_id" | "transfer_id"
    >,
  ): Promise<CreditTransferDelivery>;
}

export const transferHash = (value: unknown): string =>
  createHash("sha256").update(canonicalFundingTerms(value)).digest("hex");
const transactions = new WeakMap<PoolClient, Map<string, string>>();

/** All local accounts sorted before taking ANY financial or approval row lock.
 * Remote calls must finish before entry; never nest payer transactions.
 */
export async function withCreditTransferAccounts<T>(
  accounts: string[],
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const ordered = [
    ...new Set(accounts.map((id) => fundingId(id, "Transfer account"))),
  ].sort();
  for (const account_id of ordered) {
    const { home_bay_id } = await resolveAccountHomeBay({ account_id });
    if (home_bay_id !== getConfiguredBayId())
      throw Error("Transfer account is homed on a different bay");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const id of ordered) await lockAccountSpending(client, id);
    const epochs = new Map<string, string>();
    for (const id of ordered)
      epochs.set(id, await lockFundingAuthority(client, id));
    transactions.set(client, epochs);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    transactions.delete(client);
    client.release();
  }
}

function epoch(client: PoolClient, account_id: string): string {
  const value = transactions.get(client)?.get(account_id);
  if (!value)
    throw Error("Transfer requires the common locked account transaction");
  return value;
}

export async function getCreditTransferRecipientLocal(
  account_id: string,
): Promise<CreditTransferRecipient> {
  return withCreditTransferAccounts([account_id], (client) =>
    recipientInTransaction(client, account_id),
  );
}

async function recipientInTransaction(
  client: PoolClient,
  account_id: string,
): Promise<CreditTransferRecipient> {
  const authority_epoch = epoch(client, account_id);
  const {
    rows: [account],
  } = await client.query(
    `SELECT email_address,email_address_verified,display_name,first_name,last_name
    FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE AND banned IS NOT TRUE FOR SHARE`,
    [account_id],
  );
  if (
    !account?.email_address ||
    !account.email_address_verified?.[account.email_address]
  )
    throw Error(
      "Recipient must be an existing account with a verified email address",
    );
  return {
    account_id,
    home_bay_id: getConfiguredBayId(),
    authority_epoch,
    email_address: account.email_address,
    display_name:
      account.display_name ||
      [account.first_name, account.last_name].filter(Boolean).join(" ") ||
      account.email_address,
  };
}

export interface PreparedCreditTransferApproval {
  payer_account_id: string;
  terms: CreditTransferTerms;
  verified: VerifiedPaymentRoot[];
  checked_at: number;
}
const preparedIntents = new WeakSet<PreparedCreditTransferApproval>();

export async function prepareCreditTransferApproval(
  opts: { payer_account_id: string; terms: CreditTransferTerms },
  transport: CreditTransferTransport,
): Promise<PreparedCreditTransferApproval> {
  const payer_account_id = fundingId(opts.payer_account_id, "Transfer sender");
  const terms = normalizeCreditTransferTerms(opts.terms);
  if (payer_account_id === terms.recipient.account_id)
    throw Error("A credit transfer requires a different recipient");
  const payerHome = await resolveAccountHomeBay({
    account_id: payer_account_id,
  });
  const recipientHome = await resolveAccountHomeBay({
    account_id: terms.recipient.account_id,
  });
  if (
    payerHome.home_bay_id !== getConfiguredBayId() ||
    recipientHome.home_bay_id !== terms.recipient.home_bay_id
  )
    throw Error("Account authority changed; request a new preview");
  const recipient =
    recipientHome.home_bay_id === getConfiguredBayId()
      ? await getCreditTransferRecipientLocal(terms.recipient.account_id)
      : await transport.recipient(
          recipientHome.home_bay_id,
          terms.recipient.account_id,
        );
  if (transferHash(recipient) !== transferHash(terms.recipient))
    throw Error("Recipient identity changed; request a new preview");
  const { rows: candidates } = await getPool().query<{ id: number }>(
    `SELECT id FROM purchases WHERE account_id=$1
    AND service IN ('credit','auto-credit') AND cost<0 AND invoice_id LIKE 'pi_%'
    AND description->>'purpose' IN ('add-credit','auto-credit') ORDER BY id LIMIT 251`,
    [payer_account_id],
  );
  if (candidates.length > 250)
    throw Error("Payment history requires a transfer provenance checkpoint");
  const verified: VerifiedPaymentRoot[] = [];
  for (const { id } of candidates) {
    const result = await verifyPaymentPurchase(payer_account_id, id);
    if (result) verified.push(result);
  }
  const { rows: entries } = await getPool().query<{
    fragments: CreditFragment[];
  }>(
    "SELECT fragments FROM credit_transfer_entries WHERE account_id=$1 AND leg<>'debit'",
    [payer_account_id],
  );
  const roots = new Map(
    entries
      .flatMap(({ fragments }) => fragments)
      .map(({ root }) => [root.root_id, root]),
  );
  if (roots.size > 250)
    throw Error(
      "Received payment history requires a transfer provenance checkpoint",
    );
  for (const root of roots.values()) {
    if (verified.some((value) => value.root.root_id === root.root_id)) continue;
    const rootHome = await resolveAccountHomeBay({
      account_id: root.account_id,
    });
    const result =
      rootHome.home_bay_id === getConfiguredBayId()
        ? await verifyPaymentPurchase(
            root.account_id,
            root.purchase_id,
            root.root_id,
          )
        : await transport.verifyRoot(
            rootHome.home_bay_id,
            root.account_id,
            root.purchase_id,
            root.root_id,
          );
    if (result && transferHash(result.root) === transferHash(root))
      verified.push(result);
  }
  const prepared = {
    payer_account_id,
    terms,
    verified,
    checked_at: Math.min(
      Date.now(),
      ...verified.map(({ evidence }) => Date.parse(evidence.verified_at)),
    ),
  };
  preparedIntents.add(prepared);
  return prepared;
}

export async function withCreditTransferApprovalTransaction<T>(
  prepared: PreparedCreditTransferApproval,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!preparedIntents.has(prepared))
    throw Error("Missing trusted transfer preflight");
  const accounts = [prepared.payer_account_id];
  if (prepared.terms.recipient.home_bay_id === getConfiguredBayId())
    accounts.push(prepared.terms.recipient.account_id);
  return withCreditTransferAccounts(accounts, fn);
}

export async function transferableInTransaction(
  client: PoolClient,
  prepared: PreparedCreditTransferApproval,
): Promise<{
  lots: CreditFragment[];
  eligible: Set<string>;
  available: ReturnType<typeof toDecimal>;
}> {
  epoch(client, prepared.payer_account_id);
  if (
    !preparedIntents.has(prepared) ||
    !Number.isFinite(prepared.checked_at) ||
    Date.now() - prepared.checked_at > 60000
  )
    throw Error("Transfer payment verification expired");
  const { rows: unbounded } = await client.query(
    "SELECT 1 FROM purchases WHERE account_id=$1 AND cost IS NULL LIMIT 1",
    [prepared.payer_account_id],
  );
  if (unbounded.length)
    throw Error("Close unbounded running purchases before transferring credit");
  await importVerifiedPaymentRoots(
    client,
    prepared.payer_account_id,
    prepared.verified,
  );
  const eligible = new Set(prepared.verified.map(({ root }) => root.root_id));
  const lots = await readCreditLots(
    client,
    prepared.payer_account_id,
    eligible,
  );
  const total = lots
    .filter(({ root }) => eligible.has(root.root_id))
    .reduce((sum, lot) => sum.plus(lot.amount_usd), toDecimal(0));
  const spendable = toDecimal(
    await getSpendableBalance({
      account_id: prepared.payer_account_id,
      client,
      noSave: true,
    }),
  );
  const available = total.lt(spendable) ? total : spendable;
  return {
    lots,
    eligible,
    available: available.gt(0) ? available : toDecimal(0),
  };
}

/** DB-only callback for the isolated approvals worker. No public mutation RPC. */
export async function applyCreditTransferInTransaction(
  opts: {
    db: PoolClient;
    payer_account_id: string;
    operation_id: string;
    intent_id: string;
    terms: CreditTransferTerms;
  },
  prepared: PreparedCreditTransferApproval,
): Promise<CreditTransferReceipt> {
  const { db: client, payer_account_id } = opts;
  const operation_id = fundingId(opts.operation_id, "Transfer operation");
  fundingId(opts.intent_id, "Approval intent");
  const terms = normalizeCreditTransferTerms(opts.terms);
  const sender_authority_epoch = epoch(client, payer_account_id);
  if (
    !preparedIntents.has(prepared) ||
    prepared.payer_account_id !== payer_account_id ||
    transferHash(terms) !== transferHash(prepared.terms)
  )
    throw Error("Approval terms do not match transfer preflight");
  const {
    rows: [existing],
  } = await client.query(
    "SELECT manifest,terms_hash,state FROM credit_transfers WHERE sender_account_id=$1 AND operation_id=$2 FOR UPDATE",
    [payer_account_id, operation_id],
  );
  if (existing) {
    if (existing.terms_hash !== transferHash(terms))
      throw Error("Transfer operation already has different terms");
    const {
      rows: [entry],
    } = await client.query(
      "SELECT receipt FROM credit_transfer_entries WHERE transfer_id=$1 AND leg='debit'",
      [existing.manifest.transfer_id],
    );
    return { ...entry.receipt, state: existing.state };
  }
  const {
    rows: [sender],
  } = await client.query(
    "SELECT 1 FROM accounts WHERE account_id=$1 AND banned IS NOT TRUE AND deleted IS NOT TRUE FOR SHARE",
    [payer_account_id],
  );
  if (!sender) throw Error("Sender account is unavailable");
  const {
    rows: [limits],
  } = await client.query(
    `SELECT count(*)::int AS count,COALESCE(sum((manifest->'terms'->>'amount_usd')::numeric),0)::text AS amount
    FROM credit_transfers WHERE sender_account_id=$1 AND created_at>now()-interval '24 hours'`,
    [payer_account_id],
  );
  if (
    limits.count >= 20 ||
    toDecimal(limits.amount)
      .plus(terms.amount_usd)
      .gt(CREDIT_TRANSFER_DAILY_MAX_USD)
  )
    throw Error("Daily credit transfer limit reached");
  const { lots, eligible, available } = await transferableInTransaction(
    client,
    prepared,
  );
  if (available.lt(terms.amount_usd))
    throw Error("Insufficient cleared, unencumbered payment credit");
  const sameBay = terms.recipient.home_bay_id === getConfiguredBayId();
  if (
    sameBay &&
    transferHash(
      await recipientInTransaction(client, terms.recipient.account_id),
    ) !== transferHash(terms.recipient)
  )
    throw Error("Recipient identity changed");
  const manifest: CreditTransferManifest = {
    version: 1,
    approval_intent_id: opts.intent_id,
    transfer_id: randomUUID(),
    operation_id,
    sender_account_id: payer_account_id,
    sender_home_bay_id: getConfiguredBayId(),
    sender_authority_epoch,
    terms,
    fragments: selectCreditFragments(lots, eligible, terms.amount_usd),
    created_at: new Date().toISOString(),
  };
  // Reject an undeliverable/oversized manifest before committing a cross-bay debit.
  canonicalFundingTerms(manifest);
  await client.query(
    `INSERT INTO credit_transfers (transfer_id,operation_id,sender_account_id,recipient_account_id,recipient_home_bay_id,terms_hash,manifest,state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
    [
      manifest.transfer_id,
      operation_id,
      payer_account_id,
      terms.recipient.account_id,
      terms.recipient.home_bay_id,
      transferHash(terms),
      manifest,
    ],
  );
  const receipt = await writeTransferLeg(
    client,
    manifest,
    "debit",
    sameBay ? "received" : "pending",
  );
  if (sameBay) {
    const delivery = await receiveInTransaction(client, manifest);
    if (delivery.state !== "received")
      throw Error("Same-bay recipient rejected the transfer");
    await client.query(
      "UPDATE credit_transfers SET state='received',updated_at=now() WHERE transfer_id=$1",
      [manifest.transfer_id],
    );
  }
  return receipt;
}

async function writeTransferLeg(
  client: PoolClient,
  manifest: CreditTransferManifest,
  leg: "debit" | "credit" | "compensation",
  state: CreditTransferReceipt["state"],
): Promise<CreditTransferReceipt> {
  const account_id =
    leg === "credit"
      ? manifest.terms.recipient.account_id
      : manifest.sender_account_id;
  epoch(client, account_id);
  const counterpart =
    leg === "credit"
      ? manifest.sender_account_id
      : manifest.terms.recipient.account_id;
  const purchase_id = await createPurchase({
    client,
    account_id,
    service: "credit-transfer",
    cost: toDecimal(manifest.terms.amount_usd).mul(leg === "debit" ? 1 : -1),
    description: {
      type: "credit-transfer",
      transfer_id: manifest.transfer_id,
      direction:
        leg === "debit"
          ? "sent"
          : leg === "credit"
            ? "received"
            : "compensation",
      counterpart_account_id: counterpart,
    },
  });
  const receipt: CreditTransferReceipt = {
    transfer_id: manifest.transfer_id,
    operation_id: manifest.operation_id,
    sender_account_id: manifest.sender_account_id,
    recipient_account_id: manifest.terms.recipient.account_id,
    amount_usd: manifest.terms.amount_usd,
    currency: "USD",
    state,
    created_at: manifest.created_at,
    updated_at: new Date().toISOString(),
    purchase_id,
    direction:
      leg === "debit" ? "sent" : leg === "credit" ? "received" : "returned",
    counterpart_account_id: counterpart,
  };
  await client.query(
    "INSERT INTO credit_transfer_entries (id,transfer_id,account_id,purchase_id,leg,fragments,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [
      randomUUID(),
      manifest.transfer_id,
      account_id,
      purchase_id,
      leg,
      JSON.stringify(manifest.fragments),
      receipt,
    ],
  );
  await notifyTransfer(client, manifest, leg, state);
  return receipt;
}

async function notifyTransfer(
  client: PoolClient,
  manifest: CreditTransferManifest,
  leg: "debit" | "credit" | "compensation" | "completed",
  state: CreditTransferReceipt["state"],
) {
  const account_id =
    leg === "credit"
      ? manifest.terms.recipient.account_id
      : manifest.sender_account_id;
  const summary = {
    notice_type: "billing_credit_transfer_receipt",
    title:
      leg === "debit" || leg === "completed"
        ? "Account credit sent"
        : leg === "credit"
          ? "Account credit received"
          : "Account credit transfer returned",
    body_markdown: `USD ${toDecimal(manifest.terms.amount_usd).toFixed(2)}. Transfer ${manifest.transfer_id}. Status: ${state}.`,
    severity: "info",
    origin_label: "Account billing",
    action_label: "View billing",
    action_link: "/settings/balance",
  };
  await createNotificationEventGraphInTransaction({
    db: client,
    input: {
      kind: "account_notice",
      source_bay_id: getConfiguredBayId(),
      origin_kind: "system",
      payload_json: summary,
      targets: [
        {
          target_account_id: account_id,
          target_home_bay_id: getConfiguredBayId(),
          dedupe_key: `credit-transfer:${manifest.transfer_id}:${leg}`,
          summary_json: summary,
        },
      ],
    },
  });
}

async function receiveInTransaction(
  client: PoolClient,
  manifest: CreditTransferManifest,
  unavailable = false,
): Promise<CreditTransferDelivery> {
  const account_id = manifest.terms.recipient.account_id;
  const manifest_hash = transferHash(manifest);
  const {
    rows: [existing],
  } = await client.query<CreditTransferDelivery>(
    "SELECT transfer_id,manifest_hash,state FROM credit_transfer_deliveries WHERE transfer_id=$1 FOR UPDATE",
    [manifest.transfer_id],
  );
  if (existing) {
    if (existing.manifest_hash !== manifest_hash)
      throw Error("Transfer delivery terms conflict");
    return existing;
  }
  let rejected = unavailable;
  try {
    rejected =
      unavailable ||
      transferHash(await recipientInTransaction(client, account_id)) !==
        transferHash(manifest.terms.recipient);
  } catch {
    rejected = true;
  }
  const state = rejected ? "rejected" : "received";
  await client.query(
    "INSERT INTO credit_transfer_deliveries (transfer_id,recipient_account_id,sender_home_bay_id,manifest_hash,state,reason) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      manifest.transfer_id,
      account_id,
      manifest.sender_home_bay_id,
      manifest_hash,
      state,
      rejected ? "recipient identity or authority changed" : null,
    ],
  );
  if (!rejected) await writeTransferLeg(client, manifest, "credit", "received");
  return { transfer_id: manifest.transfer_id, manifest_hash, state };
}

/** The current receiving authority owns imported delivery fences. An old-home
 * manifest cannot create new credit there, but an imported receipt wins. A
 * handoff in progress is uncertainty, never authorization to compensate.
 */
async function receiveCommittedTransfer(
  manifest: CreditTransferManifest,
): Promise<CreditTransferDelivery> {
  const account_id = manifest.terms.recipient.account_id;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockAccountRehomeFence({ db: client, account_id });
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('account-funding'),hashtext($1))",
      [account_id],
    );
    await assertAccountNotRehoming({
      db: client,
      account_id,
      action: "receive transferred credit",
    });
    const {
      rows: [authority],
    } = await client.query(
      "SELECT state FROM account_funding_authorities WHERE payer_account_id=$1 FOR SHARE",
      [account_id],
    );
    if (authority && authority.state !== "active")
      throw Error(
        "Recipient financial authority is moving; delivery remains pending",
      );
    let unavailable = false;
    try {
      await lockAccountSpending(client, account_id);
      transactions.set(
        client,
        new Map([[account_id, await lockFundingAuthority(client, account_id)]]),
      );
    } catch {
      // A SQL error aborts the transaction and the following write also fails;
      // only logical authority refusal can commit a durable rejection here.
      unavailable = true;
    }
    const result = await receiveInTransaction(client, manifest, unavailable);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    transactions.delete(client);
    client.release();
  }
}

export async function getOutgoingCreditTransferLocal(
  account_id: string,
  transfer_id: string,
): Promise<CreditTransferManifest> {
  const home = await resolveAccountHomeBay({ account_id });
  if (home.home_bay_id !== getConfiguredBayId())
    throw Error("Transfer sender authority changed");
  const {
    rows: [row],
  } = await getPool().query(
    "SELECT manifest FROM credit_transfers WHERE sender_account_id=$1 AND transfer_id=$2",
    [account_id, fundingId(transfer_id, "Transfer")],
  );
  if (!row) throw Error("Committed transfer not found");
  return row.manifest;
}

/** Pull the durable debit from its authoritative sender; never accept caller-supplied money. */
export async function deliverCreditTransferLocal(
  opts: {
    sender_home_bay_id: string;
    sender_account_id: string;
    transfer_id: string;
  },
  transport: CreditTransferTransport,
): Promise<CreditTransferDelivery> {
  const home = await resolveAccountHomeBay({
    account_id: opts.sender_account_id,
  });
  const manifest =
    home.home_bay_id === getConfiguredBayId()
      ? await getOutgoingCreditTransferLocal(
          opts.sender_account_id,
          opts.transfer_id,
        )
      : await transport.outgoing(
          home.home_bay_id,
          opts.sender_account_id,
          opts.transfer_id,
        );
  if (
    manifest.transfer_id !== opts.transfer_id ||
    manifest.sender_account_id !== opts.sender_account_id ||
    manifest.sender_home_bay_id !== opts.sender_home_bay_id
  )
    throw Error("Transfer delivery authority mismatch");
  const recipientHome = await resolveAccountHomeBay({
    account_id: manifest.terms.recipient.account_id,
  });
  if (recipientHome.home_bay_id !== getConfiguredBayId())
    throw Error("Transfer recipient routing changed");
  return receiveCommittedTransfer(manifest);
}

export async function reconcileCreditTransfer(
  manifest: CreditTransferManifest,
  transport: CreditTransferTransport,
): Promise<void> {
  const home = await resolveAccountHomeBay({
    account_id: manifest.sender_account_id,
  });
  if (home.home_bay_id !== getConfiguredBayId())
    throw Error("Transfer reconciliation requires sender home authority");
  const committed = await getOutgoingCreditTransferLocal(
    manifest.sender_account_id,
    manifest.transfer_id,
  );
  if (transferHash(committed) !== transferHash(manifest))
    throw Error("Transfer reconciliation terms conflict");
  const recipientHome = await resolveAccountHomeBay({
    account_id: manifest.terms.recipient.account_id,
  });
  const result = await transport.deliver(recipientHome.home_bay_id, manifest);
  if (
    result.transfer_id !== manifest.transfer_id ||
    result.manifest_hash !== transferHash(manifest) ||
    !["received", "rejected"].includes(result.state)
  )
    throw Error("Invalid transfer receipt");
  await withCreditTransferAccounts(
    [manifest.sender_account_id],
    async (client) => {
      const {
        rows: [row],
      } = await client.query(
        "SELECT state,manifest FROM credit_transfers WHERE transfer_id=$1 AND sender_account_id=$2 FOR UPDATE",
        [manifest.transfer_id, manifest.sender_account_id],
      );
      if (!row || transferHash(row.manifest) !== transferHash(manifest))
        throw Error("Transfer reconciliation terms conflict");
      if (row.state !== "pending") return;
      const state = result.state === "received" ? "received" : "compensated";
      if (result.state === "rejected")
        await writeTransferLeg(client, manifest, "compensation", state);
      else await notifyTransfer(client, manifest, "completed", state);
      await client.query(
        "UPDATE credit_transfers SET state=$2,updated_at=now() WHERE transfer_id=$1",
        [manifest.transfer_id, state],
      );
      await client.query(
        "UPDATE credit_transfer_entries SET receipt=receipt || jsonb_build_object('state',$2::text,'updated_at',now()) WHERE transfer_id=$1 AND leg='debit'",
        [manifest.transfer_id, state],
      );
    },
  );
}
