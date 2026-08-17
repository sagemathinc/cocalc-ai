# cocalc.com Redirect, SEO, and Legacy Account Migration Plan

Date: 2026-07-09

## Context

The old `cocalc.com` site was retired during the migration to `cocalc.ai`.
The current emergency risk is not just that users see a retirement notice. The
larger issue is that historical `cocalc.com` URLs were briefly redirected to a
`workers.dev` hostname and flattened to one generic page. That has three bad
effects:

- Chrome may treat the `workers.dev` hostname as a lookalike or fraudulent site.
- Search engines lose the relationship between high-value historical URLs and
  their corresponding new `cocalc.ai` pages.
- Users who follow old project or sign-in links get no context-specific guidance.

The desired outcome is:

- users never see a `workers.dev` hostname;
- old public URLs preserve SEO value by redirecting to the best matching
  `cocalc.ai` URL;
- old project URLs guide users into the legacy migration flow;
- old sign-in URLs explain that users need a new `cocalc.ai` account, then route
  them to migration after account creation;
- support, status, and UI text are explicit about what is available, unavailable,
  or unrecoverable.

## Current Emergency State

As of the emergency Cloudflare rule update, `cocalc.com` redirects are expected
to point directly to `https://cocalc.ai` while preserving the path and query
string. This is the correct short-term posture.

Keep the emergency rule as a temporary `302` until the URL inventory and special
cases below are verified. Once verified, stable public marketing/documentation
routes should become permanent `301` or `308` redirects.

## Principles

- Never redirect users to `*.workers.dev` for `cocalc.com` traffic.
- Preserve path and query string unless a route-specific resolver is better.
- Prefer route-specific redirects for legacy project, auth, and support paths.
- Use temporary redirects while validating mappings, then permanent redirects for
  stable public pages.
- Keep `cocalc.com` redirect behavior indefinitely; it is a permanent asset with
  years of external links.
- Avoid claiming legacy data is available unless the backend has evidence of an
  R2 artifact or another recoverable source.

## Phase 0: Immediate Safety Checks

Verify the current emergency behavior from a terminal and a normal Chrome tab:

```bash
curl -I https://cocalc.com/
curl -I https://cocalc.com/features/terminal
curl -I 'https://cocalc.com/pricing?source=test'
curl -I https://www.cocalc.com/features/python
curl -I https://cocalc.com/projects/00000000-0000-0000-0000-000000000000/files/example.ipynb
```

Expected:

- no `Location` header contains `workers.dev`;
- public marketing paths redirect to the same path on `https://cocalc.ai`;
- query strings are preserved;
- `www.cocalc.com` either redirects directly to `cocalc.ai` or redirects first
  to `cocalc.com` and then to `cocalc.ai`.

If Chrome still shows the lookalike warning, clear the browser cache for
`cocalc.com`, use a private window, and confirm the network redirect chain does
not contain `workers.dev`.

## Phase 1: Cloudflare Redirect Architecture

Implement redirects using one of these two Cloudflare approaches:

- Preferred for simple path preservation: Cloudflare Redirect Rules.
- Preferred for route-specific project/auth logic: a Cloudflare Worker bound to
  the route `cocalc.com/*`, not a visible `workers.dev` hostname.

The Worker must be attached to the custom domain route. Users should only see
`cocalc.com` and `cocalc.ai`.

Recommended initial Worker logic:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);

    const project = url.pathname.match(
      /^\/projects\/([0-9a-f-]{36})(?:\/files\/(.*))?$/i,
    );
    if (project) {
      const target = new URL("/settings/legacy-migration", "https://cocalc.ai");
      target.searchParams.set("legacy_project_id", project[1]);
      if (project[2]) target.searchParams.set("legacy_path", project[2]);
      return Response.redirect(target.toString(), 302);
    }

    const target = new URL(url.pathname + url.search, "https://cocalc.ai");
    return Response.redirect(target.toString(), 302);
  },
};
```

### Public-share compatibility resolver

The hub now provides `/legacy/<original-path>` as a compatibility resolver.
It checks the bounded longest prefixes of the original path against the
cross-bay public-share slug directory. A match redirects to the corresponding
`/share/...` route; a miss or directory lookup failure redirects to the same
path on `cocalc.ai`, preserving the pre-resolver migration behavior.

After the hub version containing that route is deployed, the `cocalc.com/*`
Worker can remain deliberately database-free and send every path through the
resolver:

```js
export default {
  async fetch(request) {
    const source = new URL(request.url);
    const target = new URL(
      `/legacy${source.pathname}${source.search}`,
      "https://cocalc.ai",
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        "Cache-Control": "no-store",
        "X-CoCalc-Migration-Policy": "temporary",
      },
    });
  },
};
```

Deploy in this order:

1. Deploy the hub `/legacy/*` route to every bay.
2. Verify known share matches and non-share fallbacks directly on
   `cocalc.ai/legacy/...`.
3. Change the Worker target from `https://cocalc.ai<original-path>` to
   `https://cocalc.ai/legacy<original-path>`.
4. Keep both hops as `302` until production samples, Unicode/space encoding,
   query preservation, and disabled-share behavior have been verified.

Expected examples:

```text
https://cocalc.com/georeg/matrix-certificates/notebook
  -> https://cocalc.ai/legacy/georeg/matrix-certificates/notebook
  -> https://cocalc.ai/share/georeg/matrix-certificates/notebook

https://cocalc.com/features/terminal
  -> https://cocalc.ai/legacy/features/terminal
  -> https://cocalc.ai/features/terminal
```

After validation, change stable public routes from `302` to `301` or `308`.
Keep legacy project and auth flows as `302` until the resolver behavior is fully
stable.

## Phase 2: URL Inventory and Mapping

Create a concrete mapping table from these sources:

- old Next.js page routes under the historical `cocalc.com` source tree;
- old sitemap files, if available;
- Cloudflare analytics for top `cocalc.com` paths;
- Google Search Console top indexed pages and top linked pages;
- support request URLs from the migration period;
- high-value manually known pages, especially feature, pricing, policy, and
  teaching pages.

Initial redirect categories:

| Old route category         | Target behavior                                                              |
| -------------------------- | ---------------------------------------------------------------------------- |
| `/`                        | `https://cocalc.ai/`                                                         |
| `/features...`             | preserve path on `https://cocalc.ai`                                         |
| `/pricing...`              | preserve path on `https://cocalc.ai`                                         |
| `/about...`                | preserve path on `https://cocalc.ai`                                         |
| `/software...`             | preserve path if supported; otherwise nearest software landing page          |
| `/policies...`             | preserve path on `https://cocalc.ai`                                         |
| `/support...`              | preserve path when supported; otherwise support landing page                 |
| `/auth/sign-in`            | route to sign-in with legacy-account guidance                                |
| `/auth/sign-up`            | route to sign-up with legacy-account guidance                                |
| `/projects/<id>/files/...` | route to a legacy project resolver or migration page                         |
| public share URLs          | route through the public-share resolver and preserve the file or folder path |

Any route that is not supported on `cocalc.ai` should map to the closest useful
replacement page, not to a generic root page.

## Phase 2A: Public Share File URLs

The current `cocalc.ai` public-share implementation supports public folder
shares and already preserves direct share file paths in frontend routing. The
project-host layer also already has read-only public-share file download and
inline preview authorization for signed-in viewers. That means restoring legacy
file-share behavior should be feasible without introducing a new data plane.

The missing product/backend piece is exact file-scope publication. During legacy
public-path replay, file-like legacy paths are currently disabled instead of
being replayed as shares. That was the safe choice because replaying a file
share as a containing-directory share would broaden access. The correct fix is
to model file shares explicitly.

Recommended implementation:

- Add a `path_type` or equivalent metadata field for public project paths with
  values `directory` and `file`.
- Keep the read policy narrow:
  - directory share: include `path/**` and allow directory listing below `path`;
  - file share: include exactly `path` and do not expose sibling listing.
- Extend `resolve`, `grantTemporaryViewerAccess`, `listDirectory`,
  `copyToProject`, and `copyToNewProject` to understand file shares.
- For file shares, render the file directly in the public viewer/project view
  instead of treating the share root as a browsable directory.
- Preserve old `/share/<slug>/...` behavior by continuing to use the existing
  longest-slug-first resolver. This lets a URL resolve either to a file share
  slug or to a directory share plus a relative file path.
- Replay legacy file public paths as exact file shares once the new file-scope
  model exists.
- Add a project File menu entry named `Publish` for both files and folders. The
  dialog should default to publishing the selected file when invoked from a file
  tab and the selected folder when invoked from the file browser.

This is worth doing. File publishing was common on `cocalc.com`, and supporting
it avoids turning many old public URLs into dead ends. The implementation is
moderate-sized rather than risky because the read-only project-host service and
public-share routing are already present; the main care point is preserving the
security invariant that publishing one file never exposes its parent directory.

## Phase 3: Legacy Project URL Resolver

Add or improve a dedicated resolver for old project URLs. The resolver should
accept:

- `legacy_project_id`;
- optional original file path;
- optional original URL.

Resolver behavior:

- If the legacy project is already migrated and the current account has access,
  redirect to the migrated project/file.
- If the user is signed in but the project is not migrated, show the migration
  dialog for that specific project.
- If the user is not signed in, ask them to create/sign in to a `cocalc.ai`
  account, then return them to the resolver.
- If the project is known and recoverable, say that clearly.
- If the project is known but no recoverable archive exists, say that clearly.
- If the project ID is unknown, explain that the project was not found in the
  legacy index and provide support guidance.

This should replace blind path-preserving redirects for `/projects/<id>/files/...`
once implemented.

## Phase 4: Sign-In and Sign-Up Guidance for Legacy Users

Problem:

Users with old `cocalc.com` accounts may try to sign in to `cocalc.ai` and not
understand that they must create a new account first. This is especially
confusing for users whose old login method is not available on `cocalc.ai`.

Recommended product behavior:

- On sign-in and sign-up pages, provide a visible migration notice:
  "If you used cocalc.com, create a cocalc.ai account first, then restore your
  legacy projects from Settings -&gt; Legacy Migration."
- When an email is entered, check a cheap backend endpoint for whether that
  email appears in legacy account metadata.
- If a legacy match exists and no current `cocalc.ai` account exists, show:
  "We found a legacy cocalc.com account for this email. Create a new cocalc.ai
  account, then you can restore eligible legacy projects."
  This is a limited email-enumeration disclosure for legacy account metadata.
  It is acceptable during the migration support window because `cocalc.com` did
  not historically enforce the same secrecy guarantee, and the benefit is
  reducing substantial user confusion.
- If a legacy match exists and a current account exists, show a link to
  `/settings/legacy-migration`.
- Do not expose private legacy account details before the user has authenticated.

Architecture note:

- In multibay deployments, account lookup and sign-in guidance must route through
  the authoritative account/home-bay layer. Do not add local-bay-only shortcuts
  that would fail when account authority is distributed.

## Phase 5: Legacy Availability Language

Replace ambiguous "Not yet available" language with state-specific language.

Suggested states:

- `Available for restore`: an R2 `.tar.zst` artifact is present and the restore
  path should work.
- `No recoverable archive found`: the project is known in legacy metadata, but
  no source archive has been found.
- `Already restored`: the project was restored into `cocalc.ai`.
- `Restored project missing`: the project was previously restored but the target
  project no longer exists; allow restore again if the source artifact exists.

Avoid using "Not yet available" for data that is actually unrecoverable.

Do not include `Restore in progress` or `Too large for automatic restore` in the
public production UI unless the migration process changes again. The current
target is to finish all feasible archive recovery before exposing the final
language to users.

## Phase 6: SEO Stabilization

After route mappings are validated:

- switch stable public route redirects to `301` or `308`;
- keep resolver/auth routes as `302` until behavior is stable;
- publish an updated `cocalc.ai` sitemap;
- submit the new sitemap in Google Search Console;
- use Google Search Console change-of-address tooling if appropriate;
- verify canonical tags on public `cocalc.ai` pages;
- verify title/description metadata for high-value routes;
- monitor indexing and crawl errors for `cocalc.com` and `cocalc.ai`.

Validation commands:

```bash
curl -I https://cocalc.com/features/terminal
curl -I https://cocalc.com/features/jupyter-notebook
curl -I https://cocalc.com/pricing
curl -I https://cocalc.com/policies/privacy
curl -I https://cocalc.com/support
```

Each should resolve to a page-specific `cocalc.ai` URL, not the root page.

## Phase 7: Monitoring and Alerting

Add lightweight monitoring for:

- any `Location` header containing `workers.dev`;
- any high-value `cocalc.com` path redirecting to the generic `cocalc.ai/` root;
- 404s on migrated `cocalc.ai` public pages;
- high-volume legacy project resolver failures;
- sign-in/sign-up users who match legacy metadata but do not reach migration.

The first monitor should be especially strict: `workers.dev` should never appear
in the user-visible redirect chain for `cocalc.com`.

## Phase 8: Support Communication

Prepare a short support macro:

> CoCalc has moved from cocalc.com to cocalc.ai. Please create a new cocalc.ai
> account, then open Settings -&gt; Legacy Migration to restore eligible legacy
> projects. If you followed an old project link, the migration page should help
> locate that project. Some legacy project history such as TimeTravel is not
> available; project files are available when a recoverable archive exists.

Prepare a public status/migration page that explains:

- why users need a new account;
- how to restore projects;
- what "available", "in progress", and "no recoverable archive found" mean;
- what data is not available, including legacy TimeTravel if applicable;
- how to contact support with a legacy project URL.

## Phase 9: Rollout Order

1. Keep the current emergency path-preserving `302` redirect in Cloudflare.
2. Verify no `workers.dev` redirects remain.
3. Build the URL inventory and high-value route map.
4. Add exact file-scope public-share support.
5. Replay legacy file public paths as exact file shares.
6. Implement the legacy project URL resolver on `cocalc.ai`.
7. Change `/projects/<id>/files/...` redirects to the resolver.
8. Add sign-in/sign-up legacy guidance.
9. Update legacy migration state labels.
10. Switch stable public routes to permanent redirects after at least two weeks
    of stable 302 behavior.
11. Submit sitemap/Search Console updates.
12. Add redirect-chain monitoring.

## Open Decisions

- Whether project URL redirects should preserve the old file path in the browser
  URL or route through a resolver page first.
  Decision: preserve the old file path when possible, but route through a
  resolver when the target project is not yet present in `cocalc.ai`. The
  resolver should offer migration if the signed-in user is authorized for the
  legacy project and a recoverable artifact exists.
- Whether unsupported old public pages should redirect to the nearest specific
  page or return a custom explanatory page.
  Decision: implement exact file-scope public shares so old public file URLs can
  resolve when their backing project is restored. Unsupported custom vanity names
  should be inventoried separately and mapped one-by-one when they matter.
- Whether legacy account email matching should be shown before authentication or
  only after account creation/sign-in.
  Decision: show this before auth for legacy account guidance. This is a limited
  legacy-account information disclosure, but it matches historical `cocalc.com`
  behavior closely enough and materially reduces user confusion. It can be
  removed after the migration support window.
- When to switch from `302` to `301`/`308` for public routes.
  Decision: wait at least two weeks after the redirect/resolver behavior is
  stable.

## Done Criteria

- Chrome no longer shows lookalike warnings for `cocalc.com`.
- `workers.dev` is absent from all user-visible redirect chains.
- Top historical public URLs redirect to page-specific `cocalc.ai` URLs.
- Legacy public file-share URLs either resolve to exact file shares or produce a
  clear unavailable message without exposing parent directories.
- Old project links send users to a useful migration/resolver flow.
- Legacy users attempting to sign in understand they need a new `cocalc.ai`
  account.
- Migration availability labels are truthful and state-specific.
- Search Console shows declining crawl errors and stable replacement indexing.
