/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { App as AntdApp } from "antd";
import {
  redux,
  Redux,
  useAccountOtherSetting,
  useAsyncEffect,
  useEffect,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  enableForceConsent,
  hasEssentialConsent,
  onConsentChange,
  restoreConsentCookieFromSnapshot,
  type ConsentSnapshot,
} from "@cocalc/frontend/cookie-consent";
import { initCookieConsent } from "@cocalc/frontend/cookie-consent/init";
import {
  LOCALIZATIONS,
  OTHER_SETTINGS_LOCALE_KEY,
  sanitizeLocale,
} from "@cocalc/frontend/i18n";
import { QueryParams } from "@cocalc/frontend/misc/query-params";
import { createRoot } from "react-dom/client";
import { setAntdNotificationInstance } from "./antd-notification";
import { AppContext, useAppContextProvider } from "./context";
import { Localize, useLocalizationCtx } from "./localize";

// App uses the context provided by Redux (for the locale, etc.) and Localize.
function CocalcApp({ children }) {
  const appState = useAppContextProvider();
  const { setLocale } = useLocalizationCtx();
  const accountLocale = useAccountOtherSetting<string>(
    OTHER_SETTINGS_LOCALE_KEY,
  );
  const timeAgoAbsolute =
    !!useAccountOtherSetting<boolean>("time_ago_absolute");
  const customizeReady = useTypedRedux("customize", "_is_configured");
  const cookieBannerEnabled = useTypedRedux(
    "customize",
    "cookie_banner_enabled",
  );
  const cookieBannerText = useTypedRedux("customize", "cookie_banner_text");
  const isLoggedIn = useTypedRedux("account", "is_logged_in");

  useEffect(() => {
    if (!customizeReady) return;
    let cancelled = false;
    let timer: number | undefined;
    const accountStore = redux.getStore("account");

    const proceed = () => {
      if (cancelled) return;
      if (cookieBannerEnabled) {
        const stored: any = accountStore.getIn([
          "other_settings",
          "cookie_consent",
        ]);
        const snap = stored?.toJS?.() ?? stored;
        restoreConsentCookieFromSnapshot(snap as ConsentSnapshot | null);
      }
      initCookieConsent({
        enabled: !!cookieBannerEnabled,
        textMarkdown: cookieBannerText,
      });
    };

    if (accountStore.get("is_ready")) {
      proceed();
    } else {
      let done = false;
      const onReady = () => {
        if (done) return;
        done = true;
        if (timer != null) window.clearTimeout(timer);
        proceed();
      };
      accountStore.once("is_ready", onReady);
      timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        accountStore.removeListener("is_ready", onReady);
        proceed();
      }, 2000);
    }

    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [customizeReady, cookieBannerEnabled, cookieBannerText]);

  useEffect(() => {
    if (!customizeReady || !cookieBannerEnabled) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    let timer: number | undefined;
    (async () => {
      const accountStore = redux.getStore("account");
      const ready =
        accountStore.get("is_ready") ||
        (await accountStore
          .async_wait({
            until: (store) => store.get("is_ready"),
            timeout: 5,
          })
          .then(() => true)
          .catch(() => false));
      if (cancelled || !ready) return;
      if (!accountStore.get("is_logged_in")) return;
      if (hasEssentialConsent()) return;
      timer = window.setTimeout(() => {
        if (cancelled || hasEssentialConsent()) return;
        cleanup = enableForceConsent();
      }, 0);
    })();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      cleanup?.();
    };
  }, [customizeReady, cookieBannerEnabled]);

  useEffect(() => {
    if (!cookieBannerEnabled || !isLoggedIn) return;
    return onConsentChange((snap: ConsentSnapshot | null) => {
      if (snap == null) return;
      const stored: any = redux
        .getStore("account")
        .getIn(["other_settings", "cookie_consent"]);
      if (
        stored != null &&
        typeof stored?.get === "function" &&
        stored.get("timestamp") === snap.timestamp &&
        stored.get("revision") === snap.revision
      ) {
        return;
      }
      redux.getActions("account").set_other_settings("cookie_consent", snap);
    });
  }, [cookieBannerEnabled, isLoggedIn]);

  // setting via ?lang=[locale] takes precedence over account settings
  // additionally ?lang_temp=[locale] temporarily changes it, used by these impersonation admin links
  useAsyncEffect(async () => {
    const lang_set = QueryParams.get("lang");
    // lang_temp sets the language *temporarily*, i.e. without changing the account settings and it is sticky
    // this is useful for impersonation – https://github.com/sagemathinc/cocalc/issues/7782
    const lang_temp = QueryParams.get("lang_temp");
    const temp = lang_temp != null;
    const lang = temp ? lang_temp : lang_set;
    if (lang != null) {
      if (lang in LOCALIZATIONS) {
        console.warn(
          `URL query parameter 'lang=${lang}' – overriding user configuration ${
            temp ? "temporary" : "permanent"
          }.`,
        );
        if (!temp) {
          const store = redux.getStore("account");
          // we have to ensure the account store is available, because this code runs very early
          await store.async_wait({
            until: () => store.get_account_id() != null,
          });
          redux
            .getActions("account")
            .set_other_settings(OTHER_SETTINGS_LOCALE_KEY, lang);
        }
        setLocale(lang);
      } else {
        console.warn(
          `URL query parameter '${JSON.stringify({
            lang_set,
            lang_temp,
          })}' provided, but not a valid locale.`,
          `Known values: ${Object.keys(LOCALIZATIONS)}`,
        );
      }
      if (!temp) {
        // removing the parameter, otherwise this conflicts with further changes of account settings
        QueryParams.remove("lang");
      }
    } else {
      setLocale(sanitizeLocale(accountLocale));
    }
  }, [accountLocale]);

  const timeAgo = {
    timeAgoAbsolute,
    setTimeAgoAbsolute: (absolute: boolean) => {
      redux
        .getActions("account")
        .set_other_settings("time_ago_absolute", absolute);
    },
  };

  return (
    <AppContext.Provider value={{ ...appState, ...timeAgo }}>
      {children}
    </AppContext.Provider>
  );
}

function AntdNotificationBridge() {
  const { notification } = AntdApp.useApp();

  useEffect(() => {
    setAntdNotificationInstance(notification);
    return () => setAntdNotificationInstance(undefined);
  }, [notification]);

  return null;
}

function Root({ Page }) {
  return (
    <Redux>
      <Localize>
        <AntdApp>
          <AntdNotificationBridge />
          <CocalcApp>
            <Page />
          </CocalcApp>
        </AntdApp>
      </Localize>
    </Redux>
  );
}

export async function render(): Promise<void> {
  finishedLoading(); // comment this out to leave the loading/startup banner visible so you can use the Chrome dev tools with it.
  const container = document.getElementById("cocalc-webapp-container");
  const root = createRoot(container!);
  const { Page } = await import("./page");
  root.render(<Root Page={Page} />);
}

// When loading is done, remove any visible artifacts.
// This doesn't remove anything added to the head.
function finishedLoading() {
  const load = document.getElementById("cocalc-load-container");
  if (load != null) {
    load.innerHTML = "";
    load.remove();
  }
}
