/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startCourseFundingApprovalServer } from "./approval-server";
import {
  fundingApprovalRelatedOrigin,
  validateFundingListener,
  fundingApprovalConfigFromEnv,
} from "./approval-config";
import {
  beginFundingApprovalEmail,
  beginFundingApprovalPassword,
  completeFundingApprovalEmail,
  finishFundingApprovalPasskey,
  getFundingApprovalEmailStatus,
  issueFundingApprovalSession,
  requireFundingApprovalSession,
  startFundingApprovalPasskey,
} from "./approval-auth";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import type { FundingIntent } from "./approvals";
import type { CourseFundingApprovalTerms } from "./approval-review";

jest.mock("./approval-auth", () => ({
  fundingSessionHash: (token: string) =>
    require("node:crypto").createHash("sha256").update(token).digest("hex"),
  beginFundingApprovalEmail: jest.fn(),
  beginFundingApprovalPassword: jest.fn(),
  completeFundingApprovalEmail: jest.fn(),
  finishFundingApprovalPasskey: jest.fn(),
  getFundingApprovalEmailStatus: jest.fn(),
  issueFundingApprovalSession: jest.fn(),
  requireFundingApprovalSession: jest.fn(),
  startFundingApprovalPasskey: jest.fn(),
  verifyFundingApprovalCode: jest.fn(),
}));

jest.setTimeout(60_000);
async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.2", done));
  const port = (server.address() as { port: number }).port;
  await close(server);
  return port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((err) => (err ? reject(err) : done())),
  );
}

describe("approval listener configuration", () => {
  it("is disabled by default and rejects a shared host even on another port", () => {
    const original = process.env.COCALC_FUNDING_APPROVAL_ENABLED;
    delete process.env.COCALC_FUNDING_APPROVAL_ENABLED;
    expect(fundingApprovalConfigFromEnv()).toBeUndefined();
    if (original != null)
      process.env.COCALC_FUNDING_APPROVAL_ENABLED = original;
    expect(() =>
      validateFundingListener({
        origin: "https://app.example.test",
        listen_host: "127.0.0.2",
        listen_port: 19202,
        trusted_proxy_ip: "127.0.0.1",
        application_origins: ["https://app.example.test:8443"],
      }),
    ).toThrow("share a host");
  });
  it("requires a pinned TLS proxy for HTTPS", () => {
    expect(() =>
      validateFundingListener({
        origin: "https://approve.example.test",
        listen_host: "127.0.0.2",
        listen_port: 19202,
        application_origins: ["https://app.example.test"],
      }),
    ).toThrow("pinned");
  });
  it("supports child and explicitly published related approval origins", () => {
    const related = {
      origin: "https://approve-lite.example.test",
      listen_host: "127.0.0.2" as const,
      listen_port: 19202,
      trusted_proxy_ip: "127.0.0.1" as const,
      application_origins: ["https://lite.example.test"],
      webauthn_rp_id: "lite.example.test",
    };
    expect(() => validateFundingListener(related)).not.toThrow();
    expect(fundingApprovalRelatedOrigin(related)).toBe(related.origin);

    const child = {
      ...related,
      origin: "https://approve.lite.example.test",
    };
    expect(() => validateFundingListener(child)).not.toThrow();
    expect(fundingApprovalRelatedOrigin(child)).toBeUndefined();

    expect(() =>
      validateFundingListener({
        ...related,
        application_origins: ["https://other.example.test"],
      }),
    ).toThrow("WebAuthn RP ID");
  });
});

describe("isolated financial browser approval", () => {
  let server: Server;
  let attacker: Server;
  let origin: string;
  let attackerOrigin: string;
  let browser: any;
  let context: any;
  let page: any;
  let loginEmail: string;
  let loginNumber = 0;
  const payer = randomUUID();
  const student = randomUUID();
  const id = randomUUID();
  const sessions = new Map<string, string>();
  const intent: FundingIntent<CourseFundingDraft, { pool_id: string }> = {
    intent_id: id,
    payer_account_id: payer,
    operation_id: randomUUID(),
    approval_url: "",
    status: "pending",
    expires_at: "2099-09-12T12:00:00.000Z",
    terms_hash: "a".repeat(64),
    terms: {
      currency: "USD",
      amount_usd: "20.0000000000",
      lane: "prepaid",
      starts_at: "2099-09-12T10:00:00.000Z",
      ends_at: "2099-10-12T10:00:00.000Z",
      allow_overcommit: false,
      course_project_id: randomUUID(),
      course_instance_id: randomUUID(),
      recipients: [
        { beneficiary_account_id: student, amount_usd: "20.0000000000" },
      ],
    },
    review: {
      payer: {
        account_id: payer,
        name: "Course Payer",
        email: "payer@example.test",
        home_bay_id: "bay-0",
      },
      recipients: [
        {
          account_id: student,
          name: "Student <img src=x onerror=alert(1)>",
          email: "student@example.test",
          home_bay_id: "bay-0",
        },
      ],
      storage_retention_hours: 72,
    },
  };
  const apply = jest.fn(async () => ({
    ...intent,
    status: "applied" as const,
  }));
  const approvals: any = {
    propose: jest.fn(),
    retrieve: jest.fn(async () => intent),
    status: jest.fn(async () => ({ status: "pending" })),
    approve: apply,
  };
  beforeAll(async () => {
    const port = await freePort();
    origin = `http://127.0.0.2:${port}`;
    attacker = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!doctype html><title>Notebook origin</title><p>Notebook origin</p>",
      );
    });
    await new Promise<void>((done) => attacker.listen(0, "127.0.0.1", done));
    attackerOrigin = `http://127.0.0.1:${(attacker.address() as { port: number }).port}`;
    approvals.approval_origin = origin;
    server = await startCourseFundingApprovalServer({
      approvals,
      config: {
        origin,
        listen_host: "127.0.0.2",
        listen_port: port,
        application_origins: [attackerOrigin],
      },
    });
    const playwright = require(
      require.resolve("playwright-core", {
        paths: [resolve(__dirname, "../../../cli/node_modules")],
      }),
    );
    browser = await playwright.chromium.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
  });
  beforeEach(async () => {
    loginEmail = `payer-${++loginNumber}@example.test`;
    apply.mockClear();
    approvals.retrieve.mockImplementation(async () => intent);
    sessions.clear();
    (beginFundingApprovalPassword as jest.Mock).mockImplementation(
      async (opts) => {
        if (
          opts.email_address !== loginEmail ||
          opts.password !== "test-password"
        )
          throw new Error("bad credentials");
        return {
          state: "ready",
          account_id: payer,
          primary_auth_method: "password",
          primary_verified_at: new Date().toISOString(),
          password_verified_at: new Date().toISOString(),
          factor_level: "none",
        };
      },
    );
    (issueFundingApprovalSession as jest.Mock).mockImplementation(
      async (opts) => {
        if (opts.auth.account_id !== payer || opts.intent_id !== id)
          throw new Error("bad credentials");
        const token = randomBytes(32).toString("hex");
        sessions.set(
          createHash("sha256").update(token).digest("hex"),
          opts.intent_id,
        );
        return { account_id: payer, token };
      },
    );
    (requireFundingApprovalSession as jest.Mock).mockImplementation(
      async (opts) => {
        if (sessions.get(opts.session_hash) !== opts.intent_id)
          throw new Error("Financial sign-in required");
        return payer;
      },
    );
    context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(5000);
  });
  afterEach(async () => {
    await context?.close();
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await close(server);
    if (attacker) await close(attacker);
  });
  async function login(heading = "Approve Course Funding") {
    await page.goto(`${origin}/funding/${id}`);
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("link", { name: "Use a password instead" }).click();
    await page.getByRole("textbox", { name: "Email address" }).fill(loginEmail);
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page
      .getByRole("button", { name: "Sign in", exact: true })
      .press("Enter");
    const response = await posted;
    const requestHeaders = await response.request().allHeaders();
    if (response.status() !== 303)
      throw new Error(
        JSON.stringify({
          status: response.status(),
          origin: requestHeaders.origin,
          fetchSite: requestHeaders["sec-fetch-site"],
          host: requestHeaders.host,
        }),
      );
    await page.waitForLoadState("networkidle");
    expect(await page.locator("body").innerText()).not.toContain(
      "Financial Approval Unavailable",
    );
    await page.getByRole("heading", { name: heading }).waitFor();
  }
  it("renders escaped identities and financial terms, with keyboard approval", async () => {
    await page.goto(`${origin}/funding/${id}`);
    expect(await page.locator(":focus").getAttribute("id")).toBe("email");
    await login();
    expect(await page.locator("body").innerText()).toContain(
      "student@example.test",
    );
    expect(await page.locator("body").innerText()).toContain("USD 20.00");
    expect(await page.locator("body").innerText()).toContain(
      "72-hour retention",
    );
    expect(await page.locator("img,script").count()).toBe(0);
    const button = page.getByRole("button", {
      name: "Approve Funding",
      exact: true,
    });
    await button.focus();
    expect(await page.locator(":focus").innerText()).toBe("Approve Funding");
    await button.press("Enter");
    await page.waitForLoadState("networkidle");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        payer_account_id: payer,
        intent_id: id,
        terms_hash: intent.terms_hash,
      }),
    );
  });
  it("supports passwordless email followed by a passkey", async () => {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: {
          get: async () => ({
            id: "credential-id",
            rawId: new Uint8Array([1, 2, 3]).buffer,
            type: "public-key",
            authenticatorAttachment: "platform",
            getClientExtensionResults: () => ({}),
            response: {
              authenticatorData: new Uint8Array([4]).buffer,
              clientDataJSON: new Uint8Array([5]).buffer,
              signature: new Uint8Array([6]).buffer,
              userHandle: null,
            },
          }),
        },
      });
    });
    const emailPending = {
      account_id: payer,
      email_address: loginEmail,
      home_bay_id: "bay-1",
      intent_id: id,
      origin,
      email_challenge_id: randomUUID(),
      expires_at: Date.now() + 60_000,
    };
    const factorPending = {
      ...emailPending,
      second_factor_challenge_id: randomUUID(),
      methods: ["passkey" as const],
    };
    (beginFundingApprovalEmail as jest.Mock).mockResolvedValue(emailPending);
    (getFundingApprovalEmailStatus as jest.Mock).mockResolvedValue({
      state: "pending",
      masked_email: "p***@example.test",
    });
    (completeFundingApprovalEmail as jest.Mock).mockResolvedValue(
      factorPending,
    );
    (startFundingApprovalPasskey as jest.Mock).mockResolvedValue({
      state: "passkey",
      challenge_id: factorPending.second_factor_challenge_id,
      options: {
        challenge: "AQID",
        allowCredentials: [{ id: "BAUG", type: "public-key" }],
        timeout: 60_000,
        userVerification: "preferred",
      },
    });
    (finishFundingApprovalPasskey as jest.Mock).mockResolvedValue({
      state: "ready",
      account_id: payer,
      primary_auth_method: "email_code",
      primary_verified_at: new Date().toISOString(),
      factor_level: "passkey",
      factor_verified_at: new Date().toISOString(),
    });

    await page.goto(`${origin}/funding/${id}`);
    await page.getByRole("textbox", { name: "Email address" }).fill(loginEmail);
    await page.getByRole("button", { name: "Continue with email" }).click();
    await page.getByRole("heading", { name: "Check your email" }).waitFor();
    await page
      .getByRole("textbox", { name: "Six-digit email approval code" })
      .fill("123456");
    await page.getByRole("button", { name: "Verify code" }).click();
    await page
      .getByRole("heading", { name: "Verify your second factor" })
      .waitFor();
    await page.getByRole("button", { name: "Use passkey" }).click();
    await page
      .getByRole("heading", { name: "Approve Course Funding" })
      .waitFor();
    expect(startFundingApprovalPasskey).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ account_id: payer }),
      }),
    );
    expect(finishFundingApprovalPasskey).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          id: "credential-id",
          type: "public-key",
        }),
      }),
    );
  });
  it("blocks notebook-origin reads, posts and framing even while signed in", async () => {
    await login();
    const cookies = await context.cookies(origin);
    expect(
      cookies.every(
        (c) =>
          c.domain === "127.0.0.2" && c.httpOnly && c.sameSite === "Strict",
      ),
    ).toBe(true);
    const hostile = await context.newPage();
    await hostile.goto(attackerOrigin);
    expect(await hostile.evaluate("document.cookie")).toBe("");
    const readable = await hostile.evaluate(
      `fetch(${JSON.stringify(`${origin}/funding/${id}`)}, {credentials:'include'}).then(r=>r.text()).then(()=>true,()=>false)`,
    );
    expect(readable).toBe(false);
    await hostile.evaluate(
      `fetch(${JSON.stringify(`${origin}/funding/${id}/approve`)}, {method:'POST',mode:'no-cors',credentials:'include',body:new URLSearchParams({csrf:'guessed',terms_hash:${JSON.stringify(intent.terms_hash)}})}).catch(()=>{})`,
    );
    await hostile.evaluate(
      `document.body.innerHTML='<iframe title="Funding" src="${origin}/funding/${id}"></iframe>'`,
    );
    await hostile.waitForTimeout(200);
    expect(
      await hostile
        .frameLocator("iframe")
        .getByRole("button", { name: "Approve Funding" })
        .count(),
    ).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });
  it.each(["none", "switch", "preserve"] as const)(
    "renders personal fallback with %s home funding",
    async (action) => {
      const vm_id = randomUUID();
      const volume_id = randomUUID();
      const personal: FundingIntent<CourseFundingApprovalTerms> = {
        ...intent,
        terms: {
          kind: "personalVMfallback",
          vm_id,
          expected_funding_version: "version-9",
          home_volume_ids: action === "none" ? [] : [volume_id],
          lane: "prepaid",
          cap_usd: "5.00",
          ends_at: "2099-10-01T12:00:00Z",
          activation: "fallback",
          fallback_reasons: ["course_exhausted", "course_expired"],
        },
        review: {
          ...intent.review,
          recipients: [],
          personal_vm_fallback: {
            vm_id,
            vm_name: "Research VM <script>alert(1)</script>",
            owner_account_id: payer,
            owning_bay_id: "bay-0",
            resource_generation: 7,
            funding_epoch: "epoch-9",
            hourly_usd: "0.125",
            protected_storage_usd: "0.75",
            egress_cap_usd: "0.50",
            storage_delete_at: "2099-10-04T12:00:00Z",
            home_volumes:
              action === "none"
                ? []
                : [
                    {
                      id: volume_id,
                      name: "Personal home <b>data</b>",
                      funding_action: action,
                      funding_mode:
                        action === "preserve" ? "account-prepaid" : undefined,
                      funding_epoch: randomUUID(),
                      resource_generation: 1,
                      attachment_generation: 1,
                      size_gb: 10,
                      hourly_usd: "0.01",
                      storage_delete_at:
                        action === "switch"
                          ? "2099-10-04T12:00:00Z"
                          : undefined,
                    },
                  ],
          },
        },
      };
      approvals.retrieve.mockResolvedValue(personal);
      await login("Approve Personal VM Funding");
      const body = await page.locator("main").innerText();
      for (const text of [
        "payer@example.test",
        "Research VM",
        "USD 5.00",
        "Course allowance exhausted",
        "Course sponsorship expired",
        "version-9",
        "epoch-9",
        "2099-10-01",
        "2099-10-04",
        "Revocation",
      ])
        expect(body).toContain(text);
      if (action === "none") expect(body).toContain("No separate home volume");
      else {
        expect(body).toContain(volume_id);
        expect(body).toContain("Personal home <b>data</b>");
        if (action === "preserve") {
          expect(body).toContain("outside this VM cap");
          expect(body).toContain("does not extend or cancel");
        }
      }
      expect(await page.locator("script").count()).toBe(0);
      await page.setViewportSize({ width: 320, height: 900 });
      const axe = readFileSync(
        require.resolve("axe-core/axe.min.js", {
          paths: [resolve(__dirname, "../../../..")],
        }),
        "utf8",
      );
      await page.evaluate(axe);
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        expect(
          (
            await page.evaluate(
              "axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})",
            )
          ).violations,
        ).toEqual([]);
        expect(
          await page.evaluate(
            "document.documentElement.scrollWidth <= innerWidth",
          ),
        ).toBe(true);
      }
    },
  );
  it("reviews storage alone without granting VM authority", async () => {
    const volume_id = randomUUID();
    approvals.retrieve.mockResolvedValue({
      ...intent,
      terms: {
        kind: "personalVolumeFunding",
        volume_id,
        expected_funding_version: randomUUID(),
        lane: "prepaid",
        cap_usd: "2.00",
        ends_at: "2099-10-01T12:00:00Z",
      },
      review: {
        ...intent.review,
        recipients: [],
        personal_volume: {
          volume_id,
          volume_name: "Data <script>alert(1)</script>",
          owner_account_id: payer,
          owning_bay_id: "bay-0",
          resource_generation: 2,
          attachment_generation: 3,
          funding_epoch: randomUUID(),
          size_gb: 20,
          hourly_usd: "0.003",
          protected_storage_usd: "0.22",
          storage_delete_at: "2099-10-04T12:00:00Z",
        },
      },
    });
    await login("Approve Personal Storage Funding");
    const body = await page.locator("main").innerText();
    for (const text of [
      volume_id,
      "USD 2.00",
      "0.003",
      "payer@example.test",
      "2099-10-04",
      "not a VM or GPU",
      "no automatic backup",
    ])
      expect(body).toContain(text);
    expect(await page.locator("script").count()).toBe(0);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await page.evaluate(
      readFileSync(
        require.resolve("axe-core/axe.min.js", {
          paths: [resolve(__dirname, "../../../..")],
        }),
        "utf8",
      ),
    );
    expect(
      (
        await page.evaluate(
          "axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})",
        )
      ).violations,
    ).toEqual([]);
  });
  it("reviews monthly collection separately from spending capacity and deposits", async () => {
    approvals.retrieve.mockResolvedValue({
      ...intent,
      terms: {
        kind: "monthlyCollection",
        enabled: true,
        expected_version: 0,
        terms_version: 1,
      },
    });
    await login("Approve Monthly Collection");
    const body = await page.locator("main").innerText();
    for (const text of [
      "payer@example.test",
      "sponsored compute charges",
      "applicable taxes",
      "does not increase",
      "automatic deposits",
      "already started",
    ])
      expect(body).toContain(text);
    expect(await page.locator("script,img").count()).toBe(0);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
  });
  it("renders verified transfer identities, exact USD and remaining transferable balance", async () => {
    approvals.retrieve.mockResolvedValue({
      ...intent,
      terms: {
        kind: "creditTransfer",
        currency: "USD",
        amount_usd: "5.00",
        recipient: {
          account_id: student,
          home_bay_id: "bay-0",
          authority_epoch: "1",
          email_address: "student@example.test",
          display_name: "Student",
        },
      },
      review: {
        ...intent.review,
        credit_transfer: {
          transferable_usd: "10.00",
          remaining_transferable_usd: "5.00",
        },
      },
    });
    await login("Approve Credit Transfer");
    const body = await page.locator("main").innerText();
    for (const text of [
      "payer@example.test",
      "student@example.test",
      "USD 5.00",
      "USD 10.00",
      "Remaining transferable",
      "separately approved transfer",
    ])
      expect(body).toContain(text);
    expect(await page.locator("script,img").count()).toBe(0);
  });
  it("renders pool closure as resulting named limits with retained liabilities", async () => {
    const terms = {
      action: "close",
      course_project_id: intent.terms.course_project_id,
      course_instance_id: intent.terms.course_instance_id,
      pool_id: randomUUID(),
      expected_version: 4,
    };
    approvals.retrieve.mockResolvedValue({
      ...intent,
      terms,
      review: {
        ...intent.review,
        pool_change: {
          terms,
          pool: {
            lane: "prepaid",
            starts_at: intent.terms.starts_at,
            ends_at: intent.terms.ends_at,
            allow_overcommit: false,
            authorized_usd: "20.00",
            released_usd: "15.00",
            spent_usd: "2.00",
            reserved_usd: "3.00",
            grants: [
              {
                beneficiary_account_id: student,
                state: "revoked",
                authorized_usd: "20.00",
                released_usd: "15.00",
              },
            ],
          },
        },
      },
    });
    await login();
    const body = await page.locator("main").innerText();
    for (const text of [
      "Close Pool And Revoke All Grants",
      "student@example.test",
      "USD 5.00",
      "version 4",
      "reserved liabilities remain covered",
      "revoked",
    ])
      expect(body).toContain(text);
    expect(body).not.toContain("undefined");
  });
  it("rejects missing CSRF, wrong Origin, bearer credentials and changed intent", async () => {
    await login();
    const csrf = await page.locator('input[name="csrf"]').inputValue();
    const headers = { Origin: origin, "Sec-Fetch-Site": "same-origin" };
    for (const requestOptions of [
      { headers, form: { terms_hash: intent.terms_hash } },
      {
        headers: { ...headers, Origin: attackerOrigin },
        form: { csrf, terms_hash: intent.terms_hash },
      },
      {
        headers: { ...headers, Authorization: "Bearer test" },
        form: { csrf, terms_hash: intent.terms_hash },
      },
    ]) {
      const response = await context.request.post(
        `${origin}/funding/${id}/approve`,
        requestOptions,
      );
      expect(response.status()).toBeGreaterThanOrEqual(400);
    }
    const changed = await context.request.post(
      `${origin}/funding/${randomUUID()}/approve`,
      { headers, form: { csrf, terms_hash: intent.terms_hash } },
    );
    expect(changed.status()).toBeGreaterThanOrEqual(400);
    expect(apply).not.toHaveBeenCalled();
  });
  it("passes focused axe and reflow checks in light/dark desktop/mobile", async () => {
    await login();
    const axe = readFileSync(
      require.resolve("axe-core/axe.min.js", {
        paths: [resolve(__dirname, "../../../..")],
      }),
      "utf8",
    );
    const output = resolve(__dirname, "../../../../.local/funding-approval");
    mkdirSync(output, { recursive: true });
    for (const mode of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: mode });
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(axe);
        const audit = await page.evaluate(
          "axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})",
        );
        expect(
          audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })),
        ).toEqual([]);
        expect(
          await page.evaluate(
            "document.documentElement.scrollWidth <= innerWidth",
          ),
        ).toBe(true);
        await page.screenshot({
          path: `${output}/${mode}-${width}.png`,
          fullPage: true,
        });
      }
    }
  });
});

it("uses host-only Secure __Host cookies behind the pinned HTTPS proxy", async () => {
  const port = await freePort();
  const origin = "https://approve.example.test";
  const approvals: any = { approval_origin: origin };
  const server = await startCourseFundingApprovalServer({
    approvals,
    config: {
      origin,
      listen_host: "127.0.0.2",
      listen_port: port,
      trusted_proxy_ip: "127.0.0.1",
      application_origins: ["https://example.test"],
      webauthn_rp_id: "example.test",
    },
  });
  const call = (localAddress: string, headers: Record<string, string>) =>
    new Promise<{ status?: number; cookies?: string[] }>((done, reject) => {
      const req = request(
        {
          hostname: "127.0.0.2",
          port,
          localAddress,
          path: `/funding/${randomUUID()}`,
          headers,
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            done({
              status: res.statusCode,
              cookies: res.headers["set-cookie"],
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    const headers = {
      Host: "approve.example.test",
      "X-Forwarded-Proto": "https",
    };
    const response = await call("127.0.0.1", headers);
    expect(response.status).toBe(200);
    expect(response.cookies?.[0]).toMatch(/^__Host-cocalc-financial-csrf=/);
    expect(response.cookies?.[0]).toContain("Secure");
    expect(response.cookies?.[0]).toContain("HttpOnly");
    expect(response.cookies?.[0]).not.toContain("Domain=");
    expect((await call("127.0.0.3", headers)).status).toBe(403);
    expect(
      (await call("127.0.0.1", { Host: "approve.example.test" })).status,
    ).toBe(403);
  } finally {
    await close(server);
  }
});
