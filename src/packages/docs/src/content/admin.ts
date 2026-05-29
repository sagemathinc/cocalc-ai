/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const ADMIN_OVERVIEW_BODY = String.raw`
## What admin docs are for

Admin docs describe operational workflows for running a CoCalc-ai site. They
are not public product docs: they assume a signed-in site administrator, current
source-derived behavior, and the security model of the running deployment.

Use admin docs when you need to operate the site, inspect users, configure
settings, publish site messages, or guide Codex to the correct admin panel
without searching source code from scratch every time.

## Admin safety model

Admin workflows can reveal account data, change site behavior, impersonate
users, reset credentials, disable 2FA, affect billing, or move ownership across
bays. Treat them as high-trust operations.

Prefer UI actions and documented CLI commands that require fresh auth for
dangerous operations. Avoid ad hoc database edits unless the docs or source
explicitly call for them.

## Navigation

Open the Admin tab from the main app. The admin landing page contains collapsible
sections for users, news, site settings, RootFS images, bay operations, backup
shards, software licenses, registration tokens, SSO, and membership tiers.

Docs actions for admin pages are stable destinations that Codex can use through
the browser action API when the current user is an admin.
`;

export const ADMIN_NEWS_BODY = String.raw`
## What admin news is for

Admin news manages public news posts, event posts, and in-app system notices.
System notices are useful for urgent operational messages such as outages,
maintenance, or service-impacting configuration changes.

## Create a system notice

1. Open the Admin tab.
2. Open **News**.
3. Choose **Create system notice**.
4. Write the notice in Markdown.
5. Set timing, visibility, and any image or link fields.
6. Save and verify how it appears in the app.

System notices are operational communication. Keep them short, concrete, and
dated when they describe an incident or maintenance window.

## News and events

Use regular news items for public product updates. Use event posts for events
that should appear on the public events surface. The same admin editor supports
Markdown, image paste/upload, and preview.
`;

export const ADMIN_SITE_SETTINGS_BODY = String.raw`
## What site settings are for

Site settings configure behavior for the running CoCalc-ai deployment. They
include product configuration, authentication options, project-host/cloud
settings, email, backup, runtime policies, and other operational controls.

## Work with settings

1. Open the Admin tab.
2. Open **Site Settings**.
3. Search for the setting or section you need.
4. Read the current value and nearby help text before changing it.
5. Save, then verify the affected workflow in the app or CLI.

Some setting changes affect security, authentication, billing, project hosts,
or backups. For those, make a note of the old value and prefer a small
roll-forward/roll-back test.

## Configuration wizards

Some settings have dedicated helper wizards, such as Cloudflare, GCP service
accounts, Nebius CLI, launcher defaults, and runtime retention policies. Use
those wizards when available instead of editing related fields independently.
`;

export const ADMIN_USERS_BODY = String.raw`
## What user management is for

The admin user search surface is the starting point for account support and
site operations. It lets admins find accounts and open account-specific tools.

## Common workflows

Search for a user by name or email, expand the result, then use the detail tags
for the workflow you need:

- **Impersonate** generates an impersonation link after recent admin
  verification and 2FA.
- **Profile** includes password reset and 2FA removal tools.
- **Ban** controls account ban state.
- **Projects** lists recent projects the account collaborates on.
- **Purchases**, **Egress**, and **Membership** expose billing, network, and
  membership tools.

## Safety

Impersonation, password reset, and removing 2FA are sensitive support actions.
Use them only for a concrete support or administrative reason, and expect fresh
admin authentication checks for dangerous operations.
`;

export const ADMIN_CLI_BODY = String.raw`
## What admin CLI workflows are for

The CoCalc CLI is often the fastest way to inspect a running dev or production
site, especially for bay/account/project-host operations. Admin CLI workflows
should use fresh environment and fresh auth so commands target the intended
hub.

## Start with the correct environment

For local hub-backed development:

~~~sh
cd src && eval "$(pnpm -s dev:hub:env)"
~~~

Refresh this after restarting the hub or changing local dev instances.

## Useful commands

~~~sh
cocalc bay list --json
cocalc account where <account_id> --json
cocalc account rehome <account_id> --bay <bay_id> --reason "..." --yes --json
cocalc account rehome-status --op-id <op_id> --source-bay <bay_id> --json
~~~

Dangerous account operations require recent admin verification. In local dev,
use:

~~~sh
cocalc auth elevate --dev
~~~

## Account-owned state

Account-private DKV/conat-persist state, including docs private notes and git
review state, must follow the account home bay. After rehome, verify the account
location and smoke-test a feature that reads account-private state.
`;

export const ADMIN_BAY_OPS_BODY = String.raw`
## What Bay Operations is for

Bay Operations is the admin overview for a multi-bay CoCalc-ai deployment. Use
it to see which bays are alive, how much work each bay owns, whether rehome
operations are running or failing, and whether backup or load projections need
attention.

## What to check first

1. Open the Admin tab.
2. Open **Bay Operations**.
3. Check heartbeat status for every bay.
4. Review account, project, and project-host ownership counts.
5. Look for failed or running rehome operations.
6. Open bay details when backup health or load projections look suspicious.

The detail view includes copyable commands for common bay inspection and
diagnostic workflows. Prefer those typed commands over ad hoc database queries.

## Ownership model

Account-private state belongs on the account home bay. Project data belongs on
the project owning bay. Project-host operations belong on the host bay. When
moving accounts, projects, or hosts, verify both the database owner fields and
the corresponding filesystem or conat-persist state.

## Safety

Bay operations are control-plane work. Do not change ownership fields manually
unless the documented move operation cannot run and you have already inspected
the source and destination bays.
`;

export const ADMIN_ROOTFS_BODY = String.raw`
## What RootFS administration is for

RootFS administration manages the runtime image catalog and the images cached
on project hosts. Use it when a runtime image should be published, hidden,
blocked, deleted, garbage-collected, or scanned on a real host.

## Common workflow

1. Open the Admin tab.
2. Open **RootFS Images**.
3. Filter for the catalog entry you care about.
4. Inspect central lifecycle state and per-host availability.
5. Use **Scan** on an online project host when you need a host-level check.
6. Hide or block images before deleting when users may still depend on them.

Scans run on project hosts. If no online host is available, start or choose a
host before expecting scan results.

## When to use this page

Use RootFS administration after changing runtime-image build or retention
policy, when a project host fails to pull an image, or before removing old
images from the catalog.
`;

export const ADMIN_BACKUP_SHARDS_BODY = String.raw`
## What backup shards are for

Backup shards describe where project backups are stored and how backup capacity
is split across the deployment. Admins use this page to inspect shard
configuration and avoid silent backup-capacity or routing mistakes.

## Review backup shards

1. Open the Admin tab.
2. Open **Backup Shards**.
3. Confirm the expected shards are present.
4. Check that shard metadata matches the intended deployment.
5. Use **Bay Operations** to inspect bay backup health if a shard looks stale or
   overloaded.

Backups are a safety boundary. Treat edits as operational changes that need a
clear reason, a rollback path, and a small verification afterwards.
`;

export const ADMIN_REGISTRATION_TOKENS_BODY = String.raw`
## What registration tokens are for

Registration tokens control special signup and onboarding flows. Use them for
private cohorts, managed classrooms, migrations, pilots, and sites where
ordinary email signup is restricted.

## Create or update a token

1. Open the Admin tab.
2. Open **Registration Tokens**.
3. Create a token or edit an existing one.
4. Confirm intended limits, expiration, and account effects.
5. Test the signup path with a non-admin account before sharing it widely.

If general email signup should be disabled, configure that in **Site
Settings**. Registration tokens are the targeted exception mechanism.

## Safety

Tokens grant access to the site. Keep names and descriptions clear enough that
another admin can tell why the token exists and when it should be removed.
`;

export const ADMIN_MEMBERSHIP_AND_LICENSES_BODY = String.raw`
## What membership tiers and software licenses are for

Membership tiers describe site-level capabilities and usage limits. Software
licenses describe purchasable or assignable license packages. Together they
control many commercial and access-policy workflows.

## Membership tiers

Use **Membership Tiers** to define or adjust standard capability bundles. Pay
special attention to dedicated-host fields such as host creation, project-host
tier, and dedicated-host usage limits. Creating hosts still also requires
normal billing and admission checks.

## Software licenses

Use **Software Licenses** to manage license tiers and concrete licenses. License
configuration can control project upgrades, max project hosts, and other
resource limits.

## Safety

Small-looking changes can affect future purchases, existing users, or dedicated
host access. Record the old value before changing limits, then verify with an
account that should receive the updated capability.
`;

export const ADMIN_MANAGED_EGRESS_BODY = String.raw`
## What Network Egress is for

Network Egress tracks managed egress that CoCalc attributes to accounts,
projects, and categories. It gives admins an operational view into recent
network usage so they can investigate unexpected traffic, understand limit
pressure, and connect support reports to concrete account or project activity.

## Review site-wide egress

1. Open the Admin tab.
2. Open **Network Egress**.
3. Choose the time range that matches the support or operations question.
4. Review top accounts, top projects, categories, and recent events.
5. Drill into the relevant user or project when the aggregate view points to a
   specific owner.

The site-wide view is for triage. It helps answer "who or what is producing
traffic right now?" before deciding whether the next step is account support,
project inspection, membership limits, or infrastructure investigation.

## Account-level egress

The admin user detail view also exposes recent and historical managed egress
for a specific account. Use the account-level view when a user asks why they
are over a managed-egress limit, or when you need to correlate traffic with
that account's projects and membership entitlements.

## Safety

Managed egress data can reveal operational behavior of user projects. Treat it
as support and abuse-investigation data. Prefer summarizing categories and
amounts rather than copying raw event details into tickets unless the ticket
needs that evidence.
`;

export const ADMIN_SSO_BODY = String.raw`
## What SSO administration is for

SSO administration configures single sign-on providers and domain policies for
a CoCalc site. Use it when an institution or organization needs SAML login,
domain-managed signup behavior, or a policy that requires users from a domain
to use a specific identity provider.

## Configure an SSO provider

1. Open the Admin tab.
2. Open **SSO Providers & Domains**.
3. Add or edit the provider.
4. Paste metadata XML when available so the form can fill the entity ID, SSO
   URL, and signing certificate.
5. Save the provider, then test sign-in with a non-admin account that belongs
   to the target domain.

Prefer metadata import over manual copy/paste. Manual fields are useful for
debugging, but metadata reduces transcription mistakes in certificates and
service URLs.

## Configure domain policy

Domain policies decide how users with matching email domains sign in. A domain
can allow passwords, require SSO, allow signup through SSO only, and optionally
require CoCalc-native 2FA. Keep policy names and notes clear enough that
another admin can understand why the rule exists.

## Safety

SSO policy changes can lock users out. Before requiring SSO for a domain,
verify that the provider works, that at least one admin has an alternate access
path, and that support knows how users should recover if their institutional
identity is unavailable.
`;
