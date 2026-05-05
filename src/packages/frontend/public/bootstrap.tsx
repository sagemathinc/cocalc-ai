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
import { getPublicRouteFromPath, isPublicTarget } from "./routes";

export async function init(): Promise<void> {
  const target = new URLSearchParams(window.location.search).get("target");
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
  if (isPublicTarget(target)) {
    window.history.replaceState({}, "", target);
  }
}
