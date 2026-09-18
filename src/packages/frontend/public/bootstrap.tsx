/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { startTransition, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import PublicApp from "./app";
import { getPublicAuthRedirectTargetFromSearch } from "./auth/routes";
import {
  attachPublicNavigationInterceptor,
  setPublicNavigationListener,
} from "./navigation";
import {
  getPublicRouteFromPath,
  isPublicTarget,
  preservePublicTargetFragment,
} from "./routes";

(globalThis as any).__cocalc_public_app = true;

export async function init(): Promise<void> {
  const target = new URLSearchParams(window.location.search).get("target");
  const fragment = window.location.hash;
  const initialPath = isPublicTarget(target)
    ? target
    : window.location.pathname + window.location.search;
  const redirectToPath = getPublicAuthRedirectTargetFromSearch(
    window.location.search,
  );
  const initialUrl = new URL(initialPath, "https://example.invalid");

  function PublicBootstrapApp() {
    const [routePath, setRoutePath] = useState(
      () => `${initialUrl.pathname}${initialUrl.search}`,
    );
    const [route, setRoute] = useState(() =>
      getPublicRouteFromPath(initialUrl.pathname, initialUrl.search),
    );
    const didMount = useRef(false);

    useEffect(() => {
      function navigate(pathname: string, search: string) {
        startTransition(() => {
          setRoutePath(`${pathname}${search}`);
          setRoute(getPublicRouteFromPath(pathname, search));
        });
      }

      setPublicNavigationListener(navigate);
      const detachNavigationInterceptor = attachPublicNavigationInterceptor();
      const onPopState = () => {
        navigate(window.location.pathname, window.location.search);
      };
      window.addEventListener("popstate", onPopState);

      return () => {
        setPublicNavigationListener(undefined);
        detachNavigationInterceptor();
        window.removeEventListener("popstate", onPopState);
      };
    }, []);

    useEffect(() => {
      const initialMount = !didMount.current;
      didMount.current = true;
      const hash = window.location.hash;
      if (!hash) {
        if (!initialMount) window.scrollTo({ top: 0 });
        return;
      }

      let id: string;
      try {
        id = decodeURIComponent(hash.slice(1));
      } catch {
        return;
      }
      function scrollToFragment(): boolean {
        if (window.location.hash !== hash) return true;
        const target = document.getElementById(id);
        if (target == null) return false;
        const header = document.querySelector(".cocalc-public-header");
        const headerHeight = header?.getBoundingClientRect().height ?? 0;
        window.scrollTo({
          top: Math.max(
            0,
            target.getBoundingClientRect().top +
              window.scrollY -
              headerHeight -
              16,
          ),
        });
        return true;
      }
      if (scrollToFragment()) return;

      // Public configuration and article content can arrive after the route
      // mounts. Stop watching on success, navigation, unmount, or timeout.
      const observer = new MutationObserver(() => {
        if (scrollToFragment()) cleanup();
      });
      const timeout = window.setTimeout(cleanup, 30_000);
      function cleanup() {
        observer.disconnect();
        window.clearTimeout(timeout);
      }
      observer.observe(document.getElementById("cocalc-webapp-container")!, {
        childList: true,
        subtree: true,
      });
      return cleanup;
    }, [routePath]);

    return <PublicApp initialRoute={route} redirectToPath={redirectToPath} />;
  }

  const root = createRoot(document.getElementById("cocalc-webapp-container")!);
  root.render(<PublicBootstrapApp />);
  if (isPublicTarget(target)) {
    window.history.replaceState(
      {},
      "",
      preservePublicTargetFragment(target, fragment),
    );
  }
}
