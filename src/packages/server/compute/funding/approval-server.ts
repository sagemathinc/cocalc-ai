/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MONTHLY_COLLECTION_TERMS } from "@cocalc/util/monthly-collection";
import { createServer } from "node:http";
import express from "express";
import type { Request, Response } from "express";
import { parse } from "cookie";
import { getLogger } from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  appearanceStyleSheet,
  UI_COLORS,
} from "@cocalc/util/appearance-palette";
import {
  beginFundingApprovalEmail,
  beginFundingApprovalPassword,
  completeFundingApprovalEmail,
  finishFundingApprovalPasskey,
  fundingSessionHash,
  getFundingApprovalEmailStatus,
  issueFundingApprovalSession,
  requireFundingApprovalSession,
  startFundingApprovalPasskey,
  verifyFundingApprovalCode,
  type FundingApprovalPendingAuth,
  type FundingApprovalReadyAuth,
} from "./approval-auth";
import { validateFundingListener } from "./approval-config";
import type { FundingApprovalListenerConfig } from "./approval-config";
import type { CourseFundingApprovals, FundingIntent } from "./approvals";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import type {
  FundingApprovalIdentity,
  CourseFundingApprovalTerms,
} from "./approval-review";
import { toDecimal } from "@cocalc/util/money";
const logger = getLogger("compute:funding:approval-server");

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function page(
  res: Response,
  title: string,
  content: string,
  opts: { script?: string; siteName?: string } = {},
) {
  const nonce = randomBytes(24).toString("base64");
  const siteName = escapeHtml(opts.siteName ?? "CoCalc");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.type("html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - ${siteName}</title>
    <style nonce="${nonce}">${appearanceStyleSheet()}*{box-sizing:border-box}body{font:16px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:${UI_COLORS.text};background:${UI_COLORS.page};min-height:100vh}.top{height:64px;background:${UI_COLORS.surface};border-bottom:1px solid ${UI_COLORS.border};display:flex;align-items:center;padding:0 24px}.brand{font-size:21px;font-weight:700;color:${UI_COLORS.text};text-decoration:none}.secure{margin-left:auto;color:${UI_COLORS.secondary};font-size:14px}main{max-width:760px;margin:40px auto;padding:0 20px 40px}.card{background:${UI_COLORS.surface};border:1px solid ${UI_COLORS.border};border-radius:8px;box-shadow:0 12px 32px ${UI_COLORS.shadow};padding:32px}.auth-card{max-width:480px;margin:auto}h1{font-size:24px;line-height:1.25;margin:0 0 8px}h2{font-size:19px}.subtitle,.muted{color:${UI_COLORS.secondary};font-size:15px;line-height:1.5}.stack{display:flex;flex-direction:column;gap:16px;margin-top:20px}.field{display:flex;flex-direction:column;gap:6px}label{font-size:14px;font-weight:600}input,button{font:inherit;max-width:100%;border-radius:8px}input{display:block;width:100%;background:${UI_COLORS.surface};color:${UI_COLORS.text};border:1px solid ${UI_COLORS.border};padding:10px 12px;font-size:16px}button{border:0;background:${UI_COLORS.primary};color:${UI_COLORS.onPrimary};font-weight:600;padding:11px 16px;cursor:pointer}button.secondary{background:${UI_COLORS.surface};border:1px solid ${UI_COLORS.controlBorder};color:${UI_COLORS.text}}button:disabled{cursor:not-allowed;opacity:.65}.link-button{background:none!important;border:0!important;color:${UI_COLORS.link}!important;padding:0!important;font-weight:400!important}.center{text-align:center}.alert{border-radius:8px;padding:10px 12px;font-size:14px;line-height:1.45;background:${UI_COLORS.infoBg};border:1px solid ${UI_COLORS.info};color:${UI_COLORS.text}}.alert-error{background:${UI_COLORS.dangerBg};border-color:${UI_COLORS.danger}}.divider{display:flex;align-items:center;gap:12px;color:${UI_COLORS.secondary};font-size:13px}.divider:before,.divider:after{content:"";height:1px;background:${UI_COLORS.border};flex:1}.method-row{display:flex;gap:8px;flex-wrap:wrap}.method-row button{width:auto}dt{font-weight:600;margin-top:12px}dd{margin:4px 0 0}pre,dd{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:8px;overflow-wrap:anywhere;border-bottom:1px solid ${UI_COLORS.border}}th:first-child{width:60%}a{overflow-wrap:anywhere;color:${UI_COLORS.link}}:focus-visible{outline:3px solid ${UI_COLORS.focus};outline-offset:3px}@media(max-width:520px){.top{padding:0 16px}.secure{display:none}main{margin-top:20px;padding:0 12px 24px}.card{padding:22px 18px}}</style></head>
    <body><header class="top"><span class="brand">${siteName}</span><span class="secure">Secure financial confirmation</span></header><main><section class="card${content.includes("data-auth-card") ? " auth-card" : ""}"><h1>${escapeHtml(title)}</h1>${content}</section></main>${opts.script ? `<script nonce="${nonce}">${opts.script}</script>` : ""}</body></html>`);
}

function passkeyScript(id: string, startCsrf: string, finishCsrf: string) {
  return `(() => {
  const button = document.getElementById("use-passkey");
  const error = document.getElementById("passkey-error");
  if (!button) return;
  const decode = (value) => {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(base64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };
  const encode = (value) => {
    const bytes = new Uint8Array(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
  };
  async function post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Passkey verification failed.");
    return result;
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    error.hidden = true;
    try {
      const started = await post("/funding/${id}/sign-in/passkey/start", { csrf: "${startCsrf}" });
      const options = started.options;
      options.challenge = decode(options.challenge);
      options.allowCredentials = (options.allowCredentials || []).map((item) => ({ ...item, id: decode(item.id) }));
      const credential = await navigator.credentials.get({ publicKey: options });
      if (!credential) throw new Error("Passkey verification was canceled.");
      const result = await post("/funding/${id}/sign-in/passkey/finish", {
        csrf: "${finishCsrf}",
        response: {
          id: credential.id,
          rawId: encode(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment,
          clientExtensionResults: credential.getClientExtensionResults(),
          response: {
            authenticatorData: encode(credential.response.authenticatorData),
            clientDataJSON: encode(credential.response.clientDataJSON),
            signature: encode(credential.response.signature),
            userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : undefined,
          },
        },
      });
      window.location.assign(result.redirect);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : "Passkey verification failed.";
      error.hidden = false;
      button.disabled = false;
    }
  });
})();`;
}

function cookie(req: Request, name: string): string {
  // Reject duplicate cookies instead of accepting a shadowing cookie.
  const header = req.headers.cookie ?? "";
  if (
    header.split(";").filter((x) => x.trim().startsWith(`${name}=`)).length > 1
  ) {
    throw new Error("Ambiguous approval cookie");
  }
  return parse(header)[name] ?? "";
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  secure: boolean,
) {
  // HTTP is restricted to a distinct loopback IP. Production needs __Host- + Secure.
  res.cookie(name, value, {
    secure,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 15 * 60_000,
  });
}

function fundingReview(
  intent: FundingIntent<CourseFundingApprovalTerms, unknown>,
): string {
  const identity = (person: FundingApprovalIdentity) =>
    `<strong>${escapeHtml(person.name)}</strong> &lt;${escapeHtml(person.email)}&gt;`;
  const usd = (value: string) => `USD ${toDecimal(value).toFixed(2)}`;
  const { review } = intent;
  if ("kind" in intent.terms && intent.terms.kind === "monthlyCollection") {
    return `<dl><dt>Account</dt><dd>${identity(review.payer)}</dd><dt>Monthly collection</dt><dd>${intent.terms.enabled ? "Enable" : "Disable"}</dd></dl>
    <p>${escapeHtml(MONTHLY_COLLECTION_TERMS)}</p>
    <p>Disabling blocks future automatic payment attempts, not outstanding debts or already-started payments. Postpaid service may stop if it no longer has eligible billing. This is account-wide, not restricted to one course.</p>`;
  }
  if ("kind" in intent.terms && intent.terms.kind === "creditTransfer") {
    const terms = intent.terms;
    const recipient = review.recipients.find(
      (r) => r.account_id === terms.recipient.account_id,
    );
    const credit = review.credit_transfer;
    if (!recipient || !credit) throw new Error("Transfer review unavailable");
    return `<p>This transfers existing cleared paid credit to another account. It is not a course allowance and does not buy a new payment or increase postpaid capacity. A completed transfer cannot simply be cancelled; returning received credit requires a separately approved transfer.</p>
      <dl><dt>Sender</dt><dd>${identity(review.payer)}</dd><dt>Verified recipient</dt><dd>${identity(recipient)}<br>${escapeHtml(recipient.account_id)}</dd>
      <dt>Credit transferred</dt><dd>${usd(intent.terms.amount_usd)}</dd>
      <dt>Cleared transferable balance at proposal</dt><dd>${usd(credit.transferable_usd)}</dd>
      <dt>Remaining transferable balance at proposal</dt><dd>${usd(credit.remaining_transferable_usd)}</dd>
      <dt>Approval expires (UTC)</dt><dd>${escapeHtml(intent.expires_at)}</dd><dt>Status</dt><dd>${intent.status}</dd></dl>
      <p>Payment evidence, recipient identity and available credit are checked again at approval. Delivery between bays can remain pending; a timeout is not a refund or permission to transfer twice.</p>`;
  }
  if ("kind" in intent.terms && intent.terms.kind === "personalVolumeFunding") {
    const terms = intent.terms;
    const volume = review.personal_volume;
    if (!volume || volume.volume_id !== terms.volume_id)
      throw Error("Personal storage review unavailable.");
    return `<p>This authorizes only the named disk, not a VM or GPU. Its current size is fixed by this approval. Deleting a VM does not delete this disk. There is no automatic backup.</p>
      <dl><dt>Personal payer</dt><dd>${identity(review.payer)}</dd>
      <dt>Volume</dt><dd>${escapeHtml(volume.volume_name)}</dd><dt>Volume ID</dt><dd>${escapeHtml(volume.volume_id)}</dd>
      <dt>Size (GB)</dt><dd>${volume.size_gb}</dd><dt>USD per hour</dt><dd>${escapeHtml(volume.hourly_usd)}</dd>
      <dt>Maximum additional personal charges</dt><dd>${usd(terms.cap_usd)}</dd>
      <dt>Funding lane</dt><dd>${terms.lane === "prepaid" ? "Prepaid personal account balance" : "Approved personal postpaid capacity"}</dd>
      <dt>Funding ends (UTC)</dt><dd>${escapeHtml(terms.ends_at)}</dd>
      <dt>Reserved storage and cleanup</dt><dd>${usd(volume.protected_storage_usd)}</dd>
      <dt>Latest deletion (UTC)</dt><dd>${escapeHtml(volume.storage_delete_at)}</dd></dl>
      <p>The cap includes storage and cleanup. Exhaustion or cancellation can end usable storage earlier; retained storage remains billable through its funded deletion deadline. Approval does not authorize a VM restart, a larger disk, or another payment source.</p>`;
  }
  if ("kind" in intent.terms && intent.terms.kind === "personalVMfallback") {
    const terms = intent.terms;
    const vm = review.personal_vm_fallback;
    if (!vm || vm.vm_id !== terms.vm_id)
      throw new Error("Personal VM review unavailable");
    const reasons = terms.fallback_reasons.map((r) => {
      if (r === "course_exhausted") return "Course allowance exhausted";
      if (r === "course_expired") return "Course sponsorship expired";
      throw new Error("Unknown personal funding trigger");
    });
    return `<p>This authorizes charges to your personal account, not the course payer. The additional lifetime cap includes compute, egress and protected storage. Reaching the cap or end time stops personal compute; it does not authorize another payment source.</p>
      <dl><dt>Personal payer and VM owner</dt><dd>${identity(review.payer)}</dd>
      <dt>VM</dt><dd>${escapeHtml(vm.vm_name)}<br>${escapeHtml(vm.vm_id)}</dd>
      <dt>Maximum additional personal charges</dt><dd>${usd(terms.cap_usd)}</dd>
      <dt>Funding lane</dt><dd>${terms.lane === "prepaid" ? "Prepaid personal account balance" : "Approved personal postpaid capacity"}</dd>
      <dt>Activation</dt><dd>${terms.activation === "immediate" ? "Switch to personal funding now" : "Automatic fallback only for the reasons below"}</dd>
      <dt>Eligible fallback reasons</dt><dd>${reasons.length ? reasons.map(escapeHtml).join("; ") : "None; this is an immediate switch"}</dd>
      <dt>Personal authorization ends (UTC)</dt><dd>${escapeHtml(terms.ends_at)}</dd>
      <dt>Compute price per hour</dt><dd>USD ${escapeHtml(vm.hourly_usd)}</dd>
      <dt>Protected storage within cap</dt><dd>USD ${escapeHtml(vm.protected_storage_usd)}</dd>
      <dt>Egress limit within cap</dt><dd>USD ${escapeHtml(vm.egress_cap_usd)}</dd>
      <dt>Resource generation</dt><dd>${vm.resource_generation}</dd>
      <dt>Funding epoch</dt><dd>${escapeHtml(vm.funding_epoch)}</dd>
      <dt>Expected funding version</dt><dd>${escapeHtml(terms.expected_funding_version)}</dd>
      <dt>Approval expires (UTC)</dt><dd>${escapeHtml(intent.expires_at)}</dd>
      <dt>Status</dt><dd>${intent.status}</dd></dl>
      <p>Revocation, account suspension, and ambiguous billing are not eligible fallback reasons. This consent is bound to the displayed VM generation and funding epoch; it cannot authorize a different resource.</p>
      <h2>Storage And Deletion</h2><p>Stopping compute does not stop all storage charges. VM storage deletion deadline (UTC): ${escapeHtml(vm.storage_delete_at)}. No automatic backup or file synchronization protects VM-only data. Saved project notebooks and outputs remain; unsaved memory and deleted VM-only data do not.</p>
      ${vm.home_volumes.length ? `<h2>Home Volumes</h2><p>Deleting the VM does not delete them. Each disk keeps its own retention deadline.</p>${vm.home_volumes.map((v) => `<section aria-label="${escapeHtml(v.name)}"><dl><dt>Volume</dt><dd>${escapeHtml(v.name)}</dd><dt>Volume ID</dt><dd>${escapeHtml(v.id)}</dd><dt>Funding</dt><dd>${v.funding_action === "preserve" ? "Unchanged personal funding, outside this VM cap. This approval does not extend or cancel the disk's existing agreement." : "New personal storage funding within this combined cap; exhausted or cancelled funding can end it earlier."}</dd><dt>USD per hour</dt><dd>${escapeHtml(v.hourly_usd)}</dd><dt>Latest deletion (UTC)</dt><dd>${v.storage_delete_at ? escapeHtml(v.storage_delete_at) : "Existing policy; no new deletion deadline is created by this approval."}</dd></dl></section>`).join("")}` : "<p>No separate home volume is authorized by this consent.</p>"}`;
  }
  const poolChange = "action" in intent.terms ? review.pool_change : undefined;
  if ("action" in intent.terms && !poolChange)
    throw new Error("Pool change review unavailable");
  if (poolChange && typeof poolChange.pool.allow_overcommit !== "boolean")
    throw new Error("Pool overcommit policy unavailable");
  const usable = (budget: { authorized_usd: string; released_usd: string }) =>
    toDecimal(budget.authorized_usd).minus(budget.released_usd).toString();
  const terms: CourseFundingDraft = poolChange
    ? {
        course_project_id: (intent.terms as CourseFundingDraft)
          .course_project_id,
        course_instance_id: (intent.terms as CourseFundingDraft)
          .course_instance_id,
        currency: "USD",
        lane: poolChange.pool.lane,
        amount_usd: usable(poolChange.pool),
        starts_at: poolChange.pool.starts_at,
        ends_at: poolChange.pool.ends_at,
        allow_overcommit: poolChange.pool.allow_overcommit === true,
        recipients: poolChange.pool.grants.map((g) => ({
          beneficiary_account_id: g.beneficiary_account_id,
          amount_usd: usable(g),
        })),
      }
    : (intent.terms as CourseFundingDraft);
  const recipients = new Map(review.recipients.map((r) => [r.account_id, r]));
  const rows = terms.recipients
    .map((recipient) => {
      const person = recipients.get(recipient.beneficiary_account_id);
      if (!person?.email) throw new Error("Recipient identity unavailable");
      const grant = poolChange?.pool.grants.find(
        (g) => g.beneficiary_account_id === recipient.beneficiary_account_id,
      );
      return `<tr><th scope="row">${identity(person)}${grant ? `<p>${escapeHtml(grant.state)}</p><p>Starts (UTC): ${escapeHtml(grant.starts_at ?? terms.starts_at)}<br>Ends (UTC): ${escapeHtml(grant.ends_at ?? terms.ends_at)}</p>` : ""}</th><td>${usd(recipient.amount_usd)}</td></tr>`;
    })
    .join("");
  const ceilings = terms.recipients.reduce(
    (sum, r) => sum.add(r.amount_usd),
    toDecimal(0),
  );
  return `${poolChange ? `<h2>${poolChange.terms.action === "close" ? "Close Pool And Revoke All Grants" : "Revise Pool And Student Limits"}</h2><p>Resulting limits and dates are shown below. Released funds return to the payer; reserved liabilities remain covered. Revoked grants cannot authorize new sponsored work. The pool must still be at version ${poolChange.terms.expected_version}.</p>` : ""}<dl><dt>Payer</dt><dd>${identity(review.payer)}</dd><dt>${poolChange ? "Resulting pool authorization (including spent and reserved funds)" : "Pool commitment"}</dt><dd>${usd(terms.amount_usd)}</dd>
    <dt>Funding lane</dt><dd>${terms.lane === "prepaid" ? "Prepaid account balance" : "Approved postpaid capacity"}</dd>
    <dt>Starts (UTC)</dt><dd>${escapeHtml(terms.starts_at)}</dd><dt>Ends (UTC)</dt><dd>${escapeHtml(terms.ends_at)}</dd>
    <dt>Overcommit</dt><dd>${terms.allow_overcommit ? "Enabled: student ceilings are not individually guaranteed; spending stops when the shared pool is exhausted." : "Disabled: student ceilings must fit within the pool."}</dd>
    <dt>Total student ceilings</dt><dd>${usd(ceilings.toString())}</dd><dt>Approval expires (UTC)</dt><dd>${escapeHtml(intent.expires_at)}</dd>
    <dt>Status</dt><dd>${intent.status}</dd></dl>
    <h2>Students</h2><table><thead><tr><th scope="col">Student account</th><th scope="col">Allowance</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Storage Obligation</h2><p>Stopped disks can continue to incur charges. Each runtime reservation protects cleanup and storage costs within its allowance. Retained storage is deleted after the ${review.storage_retention_hours}-hour retention window unless another authorized funding source takes over. Sponsorship ending does not authorize personal charges.</p>`;
}

/** Dedicated listener only, never mounted in the normal application router. */
export async function startCourseFundingApprovalServer<Result>(opts: {
  approvals: CourseFundingApprovals<CourseFundingApprovalTerms, Result>;
  config: FundingApprovalListenerConfig;
}) {
  const { approvals } = opts;
  const { config } = opts;
  const url = validateFundingListener(config);
  if (url.origin !== approvals.approval_origin)
    throw new Error("Approval origin mismatch");
  const secure = url.protocol === "https:";
  let siteName = "CoCalc";
  try {
    const { site_name } = await getServerSettings();
    siteName = `${site_name ?? "CoCalc"}`.trim() || "CoCalc";
  } catch {
    // Minimal fixtures may not install the settings table.
  }
  const COOKIE = secure
    ? "__Host-cocalc-financial-session"
    : "cocalc_financial_dev_session";
  const CSRF_COOKIE = secure
    ? "__Host-cocalc-financial-csrf"
    : "cocalc_financial_dev_csrf";
  const FLOW_COOKIE = secure
    ? "__Host-cocalc-financial-flow"
    : "cocalc_financial_dev_flow";
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const csrfKey = randomBytes(32);
  // Bound credential attempts across this single pinned listener.
  let windowStart = Date.now();
  let attempts = 0;
  const perEmail = new Map<string, number>();
  const pendingAuth = new Map<string, FundingApprovalPendingAuth>();
  function removeExpiredPendingAuth() {
    const now = Date.now();
    for (const [flow, auth] of pendingAuth) {
      if (auth.expires_at <= now) pendingAuth.delete(flow);
    }
  }
  function rateLimit(email: string) {
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      attempts = 0;
      perEmail.clear();
      removeExpiredPendingAuth();
    }
    const count = (perEmail.get(email) ?? 0) + 1;
    if (++attempts > 60 || count > 5)
      throw new Error("Too many financial sign-in attempts");
    perEmail.set(email, count);
  }
  function csrf(
    req: Request,
    intent: string,
    purpose: string,
    secret?: string,
  ) {
    return createHmac("sha256", csrfKey)
      .update(
        JSON.stringify([
          secret ?? cookie(req, CSRF_COOKIE),
          cookie(req, COOKIE),
          intent,
          purpose,
        ]),
      )
      .digest("hex");
  }
  function checkCsrf(req: Request, intent: string, purpose: string) {
    const supplied = req.body?.csrf;
    if (
      !cookie(req, CSRF_COOKIE) ||
      typeof supplied !== "string" ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(
        Buffer.from(supplied, "hex"),
        Buffer.from(csrf(req, intent, purpose), "hex"),
      )
    ) {
      throw new Error("Invalid financial approval CSRF proof");
    }
  }
  function formToken(
    req: Request,
    res: Response,
    intent: string,
    purpose: string,
  ) {
    return `<input type="hidden" name="csrf" value="${csrfToken(req, res, intent, purpose)}">`;
  }
  function csrfToken(
    req: Request,
    res: Response,
    intent: string,
    purpose: string,
  ) {
    let secret = cookie(req, CSRF_COOKIE);
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      secret = randomBytes(32).toString("hex");
      setCookie(res, CSRF_COOKIE, secret, secure);
    }
    return csrf(req, intent, purpose, secret);
  }
  function getPendingAuth(req: Request, intent_id: string) {
    const flow = cookie(req, FLOW_COOKIE);
    const auth = /^[a-f0-9]{64}$/.test(flow)
      ? pendingAuth.get(flow)
      : undefined;
    if (
      !auth ||
      auth.intent_id !== intent_id ||
      auth.origin !== url.origin ||
      auth.expires_at <= Date.now()
    ) {
      if (flow) pendingAuth.delete(flow);
      return;
    }
    return auth;
  }
  function setPendingAuth(
    req: Request,
    res: Response,
    auth: FundingApprovalPendingAuth,
  ) {
    removeExpiredPendingAuth();
    const previousFlow = cookie(req, FLOW_COOKIE);
    if (previousFlow) pendingAuth.delete(previousFlow);
    if (pendingAuth.size >= 1_000)
      throw new Error("Too many pending financial sign-in attempts");
    const flow = randomBytes(32).toString("hex");
    pendingAuth.set(flow, auth);
    setCookie(res, FLOW_COOKIE, flow, secure);
  }
  function clearPendingAuth(req: Request, res: Response) {
    const flow = cookie(req, FLOW_COOKIE);
    if (flow) pendingAuth.delete(flow);
    res.clearCookie(FLOW_COOKIE, {
      secure,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  }
  async function finishSignIn(
    req: Request,
    res: Response,
    id: string,
    auth: FundingApprovalReadyAuth,
  ) {
    const signedIn = await issueFundingApprovalSession({
      auth,
      intent_id: id,
      origin: url.origin,
    });
    await approvals.retrieve({
      intent_id: id,
      payer_account_id: signedIn.account_id,
    });
    setCookie(res, COOKIE, signedIn.token, secure);
    setCookie(res, CSRF_COOKIE, randomBytes(32).toString("hex"), secure);
    clearPendingAuth(req, res);
  }
  function intentId(req: Request): string {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid funding intent");
    return id;
  }
  async function identity(req: Request, id: string) {
    const session_hash = fundingSessionHash(cookie(req, COOKIE));
    const payer_account_id = await requireFundingApprovalSession({
      session_hash,
      intent_id: id,
      origin: url.origin,
    });
    return { payer_account_id, session_hash };
  }
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      // no-referrer makes Chromium's native form POST Origin opaque ("null").
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (
      req.headers.host !== url.host ||
      req.socket.localAddress !== config.listen_host ||
      req.socket.localPort !== config.listen_port ||
      req.headers.authorization ||
      req.headers["x-forwarded-host"] ||
      req.headers.forwarded ||
      (secure
        ? req.socket.remoteAddress !== config.trusted_proxy_ip ||
          req.headers["x-forwarded-proto"] !== "https"
        : !!req.headers["x-forwarded-proto"])
    ) {
      res.status(403).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).end();
      return;
    }
    if (
      req.method === "POST" &&
      (req.headers.origin !== url.origin ||
        req.headers["sec-fetch-site"] !== "same-origin")
    ) {
      res.status(403).end();
      return;
    }
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.param("id", (_req, res, next, value) => {
    if (/^[0-9a-f-]{36}$/i.test(String(value)))
      res.locals.fundingIntentId = value;
    next();
  });

  app.get("/funding/:id", async (req, res) => {
    const id = intentId(req);
    let actor: Awaited<ReturnType<typeof identity>> | undefined;
    try {
      actor = await identity(req, id);
    } catch {
      /* Independent sign-in below. */
    }
    if (!actor) {
      if (req.query.restart === "1") {
        clearPendingAuth(req, res);
      }
      const auth = getPendingAuth(req, id);
      if (auth?.email_challenge_id && !auth.second_factor_challenge_id) {
        const status = await getFundingApprovalEmailStatus({
          auth,
          browser_binding: cookie(req, CSRF_COOKIE),
        });
        const proved = status.state === "email_proved";
        page(
          res,
          "Check your email",
          `<div data-auth-card></div><p class="subtitle">We sent a six-digit code to <strong>${escapeHtml(status.masked_email)}</strong>.</p>
          <div class="stack"><div class="alert">${proved ? "Your email is verified. Continue to finish confirming this financial action." : "Enter the code from your email below."}</div>
          <form class="stack" method="post" action="/funding/${id}/sign-in/email-code">${formToken(req, res, id, "email-code")}
          <div class="field"><label for="email-code">Six-digit email approval code</label><input id="email-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" ${proved ? "" : "required"}></div>
          <button type="submit">${proved ? "Continue" : "Verify code"}</button></form>
          <div class="center"><a href="/funding/${id}?restart=1">Use a different sign-in method</a></div></div>`,
          { siteName },
        );
        return;
      }
      if (auth?.second_factor_challenge_id && auth.methods?.length) {
        const hasPasskey = auth.methods.includes("passkey");
        const hasCode = auth.methods.some((method) => method !== "passkey");
        const script = hasPasskey
          ? passkeyScript(
              id,
              csrfToken(req, res, id, "passkey-start"),
              csrfToken(req, res, id, "passkey-finish"),
            )
          : undefined;
        page(
          res,
          "Verify your second factor",
          `<div data-auth-card></div><p class="subtitle">Finish signing in to ${escapeHtml(siteName)} to confirm this financial action.</p><div class="stack">
          ${hasPasskey ? `<button id="use-passkey" type="button">Use passkey</button><div id="passkey-error" class="alert alert-error" role="alert" hidden></div>` : ""}
          ${hasPasskey && hasCode ? '<div class="divider">or</div>' : ""}
          ${hasCode ? `<div class="alert">Enter either the 6-digit authenticator code or one of your recovery codes.</div><form class="stack" method="post" action="/funding/${id}/sign-in/code">${formToken(req, res, id, "second-factor-code")}<div class="field"><label for="second-factor-code">Second factor</label><input id="second-factor-code" name="code" autocomplete="one-time-code" required></div><button type="submit">Verify</button></form>` : ""}
          <div class="center"><a href="/funding/${id}?restart=1">Use a different sign-in method</a></div></div>`,
          { siteName, script },
        );
        return;
      }
      const usePassword = req.query.method === "password";
      page(
        res,
        `Sign in to ${siteName}`,
        `<div data-auth-card></div><p class="subtitle">Sign in independently on this secure ${escapeHtml(siteName)} page before confirming the financial action.</p>
        <form class="stack" method="post" action="/funding/${id}/sign-in/${usePassword ? "password" : "email"}">
        ${formToken(req, res, id, usePassword ? "password-start" : "email-start")}
        <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" placeholder="you@example.com" required autofocus></div>
        ${usePassword ? '<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required></div>' : ""}
        <button type="submit">${usePassword ? "Sign in" : "Continue with email"}</button></form>
        <div class="center" style="margin-top:16px"><a href="/funding/${id}${usePassword ? "" : "?method=password"}">${usePassword ? "Use email instead" : "Use a password instead"}</a></div>`,
        { siteName },
      );
      return;
    }
    const intent = await approvals.retrieve({
      payer_account_id: actor.payer_account_id,
      intent_id: id,
    });
    page(
      res,
      "kind" in intent.terms
        ? intent.terms.kind === "monthlyCollection"
          ? "Approve Monthly Collection"
          : intent.terms.kind === "creditTransfer"
            ? "Approve Credit Transfer"
            : intent.terms.kind === "personalVolumeFunding"
              ? "Approve Personal Storage Funding"
              : "Approve Personal VM Funding"
        : "Approve Course Funding",
      `${fundingReview(intent)}
      ${
        intent.status === "pending"
          ? `<form method="post" action="/funding/${id}/approve">${formToken(req, res, id, "approve")}
        <input type="hidden" name="terms_hash" value="${intent.terms_hash}"><button type="submit">Approve Funding</button></form>`
          : ""
      }`,
      { siteName },
    );
  });

  app.post("/funding/:id/sign-in/email", async (req, res) => {
    const id = intentId(req);
    checkCsrf(req, id, "email-start");
    const email_address = String(req.body.email ?? "")
      .trim()
      .toLowerCase();
    rateLimit(email_address);
    try {
      setPendingAuth(
        req,
        res,
        await beginFundingApprovalEmail({
          email_address,
          browser_binding: cookie(req, CSRF_COOKIE),
          intent_id: id,
          origin: url.origin,
        }),
      );
    } catch {
      throw new Error("Financial sign-in failed. Verify the account email.");
    }
    res.redirect(303, `/funding/${id}`);
  });

  app.post("/funding/:id/sign-in/password", async (req, res) => {
    const id = intentId(req);
    checkCsrf(req, id, "password-start");
    const email_address = String(req.body.email ?? "")
      .trim()
      .toLowerCase();
    rateLimit(email_address);
    try {
      const result = await beginFundingApprovalPassword({
        email_address,
        password: String(req.body.password ?? ""),
        intent_id: id,
        origin: url.origin,
      });
      if ("state" in result) await finishSignIn(req, res, id, result);
      else setPendingAuth(req, res, result);
    } catch {
      throw new Error(
        "Financial sign-in failed. Verify the account email and password.",
      );
    }
    res.redirect(303, `/funding/${id}`);
  });

  app.post("/funding/:id/sign-in/email-code", async (req, res) => {
    const id = intentId(req);
    checkCsrf(req, id, "email-code");
    const auth = getPendingAuth(req, id);
    if (!auth) throw new Error("Financial sign-in expired");
    try {
      const code = String(req.body.code ?? "").trim();
      const result = await completeFundingApprovalEmail({
        auth,
        ...(code ? { code } : {}),
      });
      if ("state" in result) await finishSignIn(req, res, id, result);
      else setPendingAuth(req, res, result);
    } catch {
      throw new Error(
        "Financial sign-in failed. Verify the email approval code.",
      );
    }
    res.redirect(303, `/funding/${id}`);
  });

  app.post("/funding/:id/sign-in/code", async (req, res) => {
    const id = intentId(req);
    checkCsrf(req, id, "second-factor-code");
    const auth = getPendingAuth(req, id);
    if (!auth) throw new Error("Financial sign-in expired");
    const code = String(req.body.code ?? "").trim();
    const method = /^\d{6}$/.test(code) ? "totp" : "recovery_code";
    if (!auth.methods?.includes(method)) {
      throw new Error("Financial sign-in failed. Verify the second factor.");
    }
    try {
      await finishSignIn(
        req,
        res,
        id,
        await verifyFundingApprovalCode({ auth, method, code }),
      );
    } catch {
      throw new Error("Financial sign-in failed. Verify the second factor.");
    }
    res.redirect(303, `/funding/${id}`);
  });

  app.get("/funding/:id/sign-in/email-status", async (req, res) => {
    const id = intentId(req);
    const auth = getPendingAuth(req, id);
    if (!auth) throw new Error("Financial sign-in expired");
    const status = await getFundingApprovalEmailStatus({
      auth,
      browser_binding: cookie(req, CSRF_COOKIE),
    });
    res.json({ state: status.state });
  });

  app.post("/funding/:id/sign-in/passkey/start", async (req, res) => {
    const id = intentId(req);
    try {
      checkCsrf(req, id, "passkey-start");
      const auth = getPendingAuth(req, id);
      if (!auth?.methods?.includes("passkey")) throw new Error();
      const started = await startFundingApprovalPasskey({
        auth,
        relying_party: {
          origin: url.origin,
          rp_id: config.webauthn_rp_id ?? url.hostname,
          rp_name: siteName,
        },
      });
      res.json({ options: started.options });
    } catch {
      res.status(400).json({ error: "Passkey verification could not start." });
    }
  });

  app.post("/funding/:id/sign-in/passkey/finish", async (req, res) => {
    const id = intentId(req);
    try {
      checkCsrf(req, id, "passkey-finish");
      const auth = getPendingAuth(req, id);
      if (!auth?.methods?.includes("passkey")) throw new Error();
      await finishSignIn(
        req,
        res,
        id,
        await finishFundingApprovalPasskey({
          auth,
          response: req.body.response as Record<string, unknown>,
        }),
      );
      res.json({ redirect: `/funding/${id}` });
    } catch {
      res.status(400).json({ error: "Passkey verification failed." });
    }
  });

  app.get("/funding/:id/status", async (req, res) => {
    const id = intentId(req);
    const actor = await identity(req, id);
    res.json(
      await approvals.status({
        intent_id: id,
        payer_account_id: actor.payer_account_id,
      }),
    );
  });

  app.post("/funding/:id/approve", async (req, res) => {
    const id = intentId(req);
    checkCsrf(req, id, "approve");
    const actor = await identity(req, id);
    await approvals.approve({
      intent_id: id,
      payer_account_id: actor.payer_account_id,
      terms_hash: String(req.body.terms_hash ?? ""),
      approved_session_hash: actor.session_hash,
    });
    res.redirect(303, `/funding/${id}`);
  });
  app.use((_req, res) => {
    res.status(404).end();
  });
  app.use(
    (
      err: unknown,
      req: Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      // No credential-bearing request or exception logging.
      logger.debug("financial approval request rejected", {
        method: req.method,
      });
      res.status(400);
      const retry = res.locals.fundingIntentId
        ? `/funding/${res.locals.fundingIntentId}`
        : "";
      page(
        res,
        "Financial Approval Unavailable",
        `<p class="alert alert-error" role="alert">${escapeHtml(err instanceof Error && (err.message.startsWith("Financial sign-in failed") || err.message === "Financial sign-in expired") ? err.message : "The request could not be completed. Check the funding request status before retrying.")}</p>${retry ? `<p><a href="${retry}">Return to funding request</a></p>` : ""}`,
        { siteName },
      );
    },
  );
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen_port, config.listen_host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
