// Load the custom manifest for our site, which is necessary so that we can
// install the page as a local webapp.  It's part of being a "progressive
// web app", as was started in this PR: https://github.com/sagemathinc/cocalc/pull/5254

import { Helmet } from "react-helmet";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
declare var DEBUG;

function shouldRegisterWebappManifest(): boolean {
  const base = appBasePath === "/" ? "" : appBasePath;
  const pathname = window.location.pathname;
  return (
    pathname === `${base}/app` ||
    pathname.startsWith(`${base}/app/`) ||
    pathname === joinUrlPath(appBasePath, "static/app.html")
  );
}

window.addEventListener("load", async function () {
  if (DEBUG || !shouldRegisterWebappManifest()) {
    return null;
  }
  const path = joinUrlPath(appBasePath, "webapp/serviceWorker.js");

  try {
    await navigator.serviceWorker.register(path, {
      scope: appBasePath,
    });
    console.log(`${path} registered successful`);
  } catch (err) {
    console.log(`${path} registration failed: `, err);
  }
});

export default function Manifest() {
  if (DEBUG || !shouldRegisterWebappManifest()) {
    return null;
  }
  return (
    <Helmet>
      <link
        rel="manifest"
        href={joinUrlPath(appBasePath, "customize?type=manifest")}
      />
    </Helmet>
  );
}
