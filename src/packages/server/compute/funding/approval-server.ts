/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import type { Request, Response } from "express";
import { parse } from "cookie";
import { getLogger } from "@cocalc/backend/logger";
import {
  appearanceStyleSheet,
  UI_COLORS,
} from "@cocalc/util/appearance-palette";
import {
  fundingSessionHash,
  requireFundingApprovalSession,
  signInFundingApprover,
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

function page(res: Response, title: string, content: string) {
  const nonce = randomBytes(24).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.type("html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
    <style nonce="${nonce}">${appearanceStyleSheet()}*{box-sizing:border-box}body{font:16px system-ui;margin:0;color:${UI_COLORS.text};background:${UI_COLORS.page}}main{max-width:760px;margin:auto;padding:24px}h1{font-size:24px}label{display:block;margin-top:16px}input,select,button{font:inherit;max-width:100%;padding:8px}input{display:block;width:100%}button{margin-top:20px}dt{font-weight:600;margin-top:12px}dd{margin:4px 0 0}pre,dd{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:8px;overflow-wrap:anywhere;border-bottom:1px solid ${UI_COLORS.border}}th:first-child{width:60%}a{overflow-wrap:anywhere;color:${UI_COLORS.link}}:focus-visible{outline:3px solid ${UI_COLORS.focus};outline-offset:3px}</style></head>
    <body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`);
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
  const COOKIE = secure
    ? "__Host-cocalc-financial-session"
    : "cocalc_financial_dev_session";
  const CSRF_COOKIE = secure
    ? "__Host-cocalc-financial-csrf"
    : "cocalc_financial_dev_csrf";
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const csrfKey = randomBytes(32);
  // Bound credential attempts across this single pinned listener.
  let windowStart = Date.now();
  let attempts = 0;
  const perEmail = new Map<string, number>();
  function rateLimit(email: string) {
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      attempts = 0;
      perEmail.clear();
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
    let secret = cookie(req, CSRF_COOKIE);
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      secret = randomBytes(32).toString("hex");
      setCookie(res, CSRF_COOKIE, secret, secure);
    }
    return `<input type="hidden" name="csrf" value="${csrf(req, intent, purpose, secret)}">`;
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
      page(
        res,
        "Financial Sign-In",
        `<form method="post" action="/funding/${id}/sign-in">
        ${formToken(req, res, id, "sign-in")}
        <label for="email">Account email</label><input id="email" name="email" type="email" autocomplete="username" required>
        <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
        <label for="method">Second factor</label><select id="method" name="method"><option value="totp">Authenticator code</option><option value="recovery_code">Recovery code</option></select>
        <label for="code">Code (when enabled)</label><input id="code" name="code" autocomplete="one-time-code">
        <button type="submit">Sign In</button></form>`,
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
        ? intent.terms.kind === "creditTransfer"
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
    );
  });

  app.post("/funding/:id/sign-in", async (req, res) => {
    const id = intentId(req);
    checkCsrf(req, id, "sign-in");
    const email_address = String(req.body.email ?? "")
      .trim()
      .toLowerCase();
    rateLimit(email_address);
    let signedIn;
    try {
      signedIn = await signInFundingApprover({
        email_address,
        password: String(req.body.password ?? ""),
        method: String(req.body.method ?? ""),
        code: String(req.body.code ?? ""),
        intent_id: id,
        origin: url.origin,
      });
      await approvals.retrieve({
        intent_id: id,
        payer_account_id: signedIn.account_id,
      });
    } catch {
      throw new Error(
        "Financial sign-in failed. Verify the payer account, password and enabled second factor.",
      );
    }
    setCookie(res, COOKIE, signedIn.token, secure);
    setCookie(res, CSRF_COOKIE, randomBytes(32).toString("hex"), secure);
    res.redirect(303, `/funding/${id}`);
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
        `<p role="alert">${escapeHtml(err instanceof Error && err.message.startsWith("Financial sign-in failed") ? err.message : "The request could not be completed. Check the funding request status before retrying.")}</p>${retry ? `<a href="${retry}">Return to Funding Request</a>` : ""}`,
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
