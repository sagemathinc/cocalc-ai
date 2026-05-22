/* Sign in using an impersonation grant. */

import basePath from "@cocalc/backend/base-path";
import clientSideRedirect from "@cocalc/server/auth/client-side-redirect";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getBayPublicOriginForRequest,
  getSitePublicOriginForRequest,
} from "@cocalc/server/bay-public-origin";
import { isLocale } from "@cocalc/util/i18n/const";
import {
  issueHomeBayRetryToken,
  verifyHomeBayRetryToken,
} from "@cocalc/server/auth/home-bay-retry-token";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { resolveAccountImpersonationGrantDirectory } from "@cocalc/server/auth/impersonation-grant-directory";
import setSignInCookies from "@cocalc/server/auth/set-sign-in-cookies";
import clearAuthCookies from "@cocalc/server/auth/clear-auth-cookies";
import {
  consumeImpersonationGrantLocal,
  createImpersonationSessionLocal,
} from "@cocalc/server/auth/impersonation";

const CONTROL_PLANE_ORIGIN_STORAGE_KEY = `cocalc-control-plane-origin:${basePath}`;
const REMEMBER_ME_STORAGE_KEY = `remember_me${basePath.startsWith("/") ? basePath.slice(1) : basePath}`;

export async function signInUsingImpersonateToken({ req, res }) {
  try {
    await doIt({ req, res });
  } catch (err) {
    res.send(`ERROR: impersonate error -- ${err}`);
  }
}

async function doIt({ req, res }) {
  const {
    retry_token,
    grant_id,
    account_id: account_id_param,
    lang_temp,
    confirm,
  } = req.query;
  const local_bay_id = getConfiguredBayId();
  let account_id: string;
  let directory_home_bay_id: string | undefined;
  let retry_home_bay_id: string | undefined;
  const grantId = `${grant_id ?? ""}`.trim();
  const hasGrantId = !!grantId;
  const confirmed = `${confirm ?? ""}` === "1";

  if (`${retry_token ?? ""}`.trim()) {
    if (!hasGrantId) {
      throw Error("grant_id is required");
    }
    const claims = verifyHomeBayRetryToken({
      token: `${retry_token}`,
      home_bay_id: local_bay_id,
      purpose: "impersonate",
    });
    account_id = `${claims.account_id ?? ""}`.trim();
    if (!account_id) {
      throw Error("invalid impersonation retry token");
    }
    retry_home_bay_id = `${claims.home_bay_id ?? ""}`.trim() || undefined;
  } else if (hasGrantId) {
    account_id = `${account_id_param ?? ""}`.trim();
    if (!account_id) {
      const entry = await resolveAccountImpersonationGrantDirectory({
        grant_id: grantId,
      });
      account_id = `${entry?.subject_account_id ?? ""}`.trim();
      directory_home_bay_id =
        `${entry?.subject_home_bay_id ?? ""}`.trim() || undefined;
      if (!account_id) {
        throw Error("invalid or expired impersonation grant");
      }
    }
    if (!confirmed) {
      const account = await getClusterAccountById(account_id);
      const home_bay_id =
        directory_home_bay_id ||
        `${account?.home_bay_id ?? ""}`.trim() ||
        local_bay_id;
      await sendImpersonationLandingPage({
        req,
        res,
        grant_id: grantId,
        account_id: `${account_id_param ?? ""}`.trim() || undefined,
        subject_email_address: account?.email_address,
        subject_name:
          `${account?.name ?? ""}`.trim() ||
          `${account?.first_name ?? ""} ${account?.last_name ?? ""}`.trim() ||
          undefined,
        home_bay_id,
        home_bay_url: await getBayPublicOriginForRequest(req, home_bay_id),
        lang_temp: isLocale(lang_temp) ? lang_temp : undefined,
      });
      return;
    }
  } else {
    throw Error("grant_id is required");
  }

  const account = await getClusterAccountById(account_id);
  const home_bay_id =
    directory_home_bay_id ||
    retry_home_bay_id ||
    `${account?.home_bay_id ?? ""}`.trim() ||
    local_bay_id;

  if (!`${retry_token ?? ""}`.trim() && home_bay_id !== local_bay_id) {
    await clearAuthCookies({ req, res });
    const retry = issueHomeBayRetryToken({
      account_id,
      home_bay_id,
      purpose: "impersonate",
    });
    const target = new URL(
      basePath === "/" ? "/auth/impersonate" : `${basePath}/auth/impersonate`,
      (await getBayPublicOriginForRequest(req, home_bay_id)) ??
        `${req.protocol === "https" ? "https" : "http"}://${req.headers.host}`,
    );
    target.searchParams.set("retry_token", retry.token);
    if (hasGrantId) {
      target.searchParams.set("grant_id", grantId);
    }
    target.searchParams.set("confirm", "1");
    if (isLocale(lang_temp)) {
      target.searchParams.set("lang_temp", lang_temp);
    }
    clientSideRedirect({ res, target: target.toString() });
    return;
  }

  if (hasGrantId) {
    const grant = await consumeImpersonationGrantLocal({
      grant_id: grantId,
      subject_account_id: account_id,
    });
    const remember = await setSignInCookies({
      req,
      res,
      account_id,
      maxAge: 12 * 3600 * 1000,
      home_bay_id,
      session: {
        authenticated_at: new Date(),
        password_verified_at: null,
        factor_verified_at: null,
        factor_level: "none",
        fresh_auth_until: null,
        metadata: {
          session_mode: "impersonation",
          actor_account_id: grant.actor_account_id,
          grant_id: grant.id,
        },
      },
    });
    await createImpersonationSessionLocal({
      session_hash: remember.hash,
      expire: remember.expire,
      grant,
      metadata: {
        lang_temp: isLocale(lang_temp) ? lang_temp : undefined,
      },
    });
  }

  const target = new URL(
    basePath === "/" ? "/app" : `${basePath}/app`,
    (await getSitePublicOriginForRequest(req)) ??
      (await getBayPublicOriginForRequest(req, home_bay_id)) ??
      `${req.protocol === "https" ? "https" : "http"}://${req.headers.host}`,
  );

  // if lang_temp is a locale, then append it as a query parameter.
  // This is usally "en" to help admins understanding the UI without changing the user's language preferences.
  if (isLocale(lang_temp)) {
    target.searchParams.set("lang_temp", lang_temp);
  }

  clientSideRedirect({ res, target: target.toString() });
}

async function sendImpersonationLandingPage({
  req,
  res,
  grant_id,
  account_id,
  subject_email_address,
  subject_name,
  home_bay_id,
  home_bay_url,
  lang_temp,
}: {
  req;
  res;
  grant_id: string;
  account_id?: string;
  subject_email_address?: string | null;
  subject_name?: string;
  home_bay_id: string;
  home_bay_url?: string;
  lang_temp?: string;
}) {
  const continueUrl = new URL(
    basePath === "/" ? "/auth/impersonate" : `${basePath}/auth/impersonate`,
    `${req.protocol === "https" ? "https" : "http"}://${req.headers.host}`,
  );
  continueUrl.searchParams.set("grant_id", grant_id);
  continueUrl.searchParams.set("confirm", "1");
  if (account_id) {
    continueUrl.searchParams.set("account_id", account_id);
  }
  if (lang_temp) {
    continueUrl.searchParams.set("lang_temp", lang_temp);
  }

  const target =
    `${subject_name ?? ""}`.trim() ||
    `${subject_email_address ?? ""}`.trim() ||
    "another CoCalc account";
  const homeBay = `${home_bay_id ?? ""}`.trim() || "the user's home bay";

  res.setHeader?.("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Confirm Support Impersonation</title>
  <style>
    :root {
      color-scheme: light;
      --border: #d9d9d9;
      --danger: #a8071a;
      --ink: #1f2933;
      --muted: #5f6b7a;
      --primary: #1677ff;
      --warning-bg: #fff7e6;
      --warning-border: #ffd591;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at top left, rgba(22, 119, 255, 0.12), transparent 32rem),
        linear-gradient(135deg, #f7f9fc 0%, #eef3f8 100%);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(760px, 100%);
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 22px 70px rgba(15, 23, 42, 0.16);
      padding: 28px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(24px, 4vw, 34px);
      line-height: 1.1;
    }
    p { line-height: 1.55; }
    .lead { color: var(--muted); margin: 0 0 22px; }
    .target {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
      background: #fafafa;
      margin: 16px 0;
    }
    .target div { margin: 4px 0; }
    .label { color: var(--muted); font-size: 13px; }
    .warning {
      border: 1px solid var(--warning-border);
      background: var(--warning-bg);
      border-radius: 12px;
      padding: 14px 16px;
      margin: 18px 0;
    }
    .detected {
      display: none;
      border-color: #ffa39e;
      background: #fff1f0;
      color: var(--danger);
      font-weight: 600;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 24px;
    }
    button, a.secondary {
      border-radius: 10px;
      padding: 10px 16px;
      font-size: 15px;
      text-decoration: none;
      cursor: pointer;
    }
    button {
      border: 1px solid var(--primary);
      background: var(--primary);
      color: white;
      font-weight: 650;
    }
    a.secondary {
      border: 1px solid var(--border);
      color: var(--ink);
      background: white;
    }
    code {
      background: #f3f4f6;
      border-radius: 5px;
      padding: 1px 5px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Confirm support impersonation</h1>
    <p class="lead">
      This link will sign this browser in as a user account so that support can
      troubleshoot exactly what the user sees.
    </p>
    <div class="target">
      <div><span class="label">Target account</span><br />${escapeHtml(target)}</div>
      <div><span class="label">Home bay</span><br /><code>${escapeHtml(homeBay)}</code></div>
    </div>
    <div class="warning">
      <strong>Recommended:</strong> open this link in a fresh incognito/private
      window. Existing cookies and local browser state can otherwise make it
      confusing which account and bay this browser is using.
    </div>
    <div id="existing-session-warning" class="warning detected">
      This browser appears to have existing CoCalc sign-in state. A private
      window is strongly recommended before continuing.
    </div>
    <p>
      Continuing will replace this browser's CoCalc sign-in state with a
      temporary impersonation session. The impersonation banner should remain
      visible after refresh.
    </p>
    <div class="actions">
      <button id="continue">Continue impersonation</button>
      <a class="secondary" href="${escapeHtml(basePath === "/" ? "/" : basePath)}">Cancel</a>
    </div>
  </main>
  <script>
    (function () {
      var controlPlaneKey = ${JSON.stringify(CONTROL_PLANE_ORIGIN_STORAGE_KEY)};
      var rememberKey = ${JSON.stringify(REMEMBER_ME_STORAGE_KEY)};
      var homeBayUrl = ${JSON.stringify(home_bay_url ?? "")};
      var continueUrl = ${JSON.stringify(continueUrl.toString())};
      var hasCookie = /(?:^|;\\s*)account_id=/.test(document.cookie || "");
      var hasStorage = false;
      try {
        hasStorage =
          localStorage.getItem(rememberKey) === "true" ||
          !!localStorage.getItem(controlPlaneKey);
      } catch (_) {}
      if (hasCookie || hasStorage) {
        document.getElementById("existing-session-warning").style.display = "block";
      }
      document.getElementById("continue").addEventListener("click", function () {
        try {
          if (homeBayUrl) {
            localStorage.setItem(controlPlaneKey, homeBayUrl);
          } else {
            localStorage.removeItem(controlPlaneKey);
          }
          localStorage.setItem(rememberKey, "true");
        } catch (_) {}
        window.location.href = continueUrl;
      });
    })();
  </script>
</body>
</html>`);
}

function escapeHtml(value: unknown): string {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
