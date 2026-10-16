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
  getPublicRedirectPath,
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
  // A page opened at a URL that moved for good starts at its new address,
  // which also replaces the old one in the address bar below.
  const movedToPath = getPublicRedirectPath(initialUrl.pathname);
  if (movedToPath != null) {
    initialUrl.pathname = movedToPath;
  }

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
      if (!didMount.current) {
        didMount.current = true;
        return;
      }
      window.scrollTo({ top: 0 });
    }, [routePath]);

    return <PublicApp initialRoute={route} redirectToPath={redirectToPath} />;
  }

  const root = createRoot(document.getElementById("cocalc-webapp-container")!);
  root.render(<PublicBootstrapApp />);
  if (movedToPath != null) {
    window.history.replaceState(
      {},
      "",
      preservePublicTargetFragment(
        `${initialUrl.pathname}${initialUrl.search}${initialUrl.hash}`,
        fragment,
      ),
    );
  } else if (isPublicTarget(target)) {
    window.history.replaceState(
      {},
      "",
      preservePublicTargetFragment(target, fragment),
    );
  }
}
