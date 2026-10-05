# CLI connectors: GitHub (`gh`) and Cloudflare (`cf`)

Date: 2026-10-05. Status: decided; implementation in progress.

Builds on the [agent connectors plan](agent-connectors-implementation-plan-2026-09-19.md)
and the shipped connector UI (#875 menu, #878 Settings → Connectors).

## Goal

An agent can run `gh` and `cf` (and `git push` to GitHub) in its project exactly
as on a laptop, using your account, without a long-lived token ever being
stored in the project. You connect each service once in Settings → Connectors.
Then you turn it on per agent from the connectors list (+) in that agent's
message box, the same way as CoCalc access today.

Cloudflare is the bigger opportunity. `cf` is a good CLI and the Cloudflare
dashboard is painful, so "ask your agent to deploy it" makes CoCalc a strong
place to build Cloudflare-hosted sites.

## How a turn gets a token (shared by both connectors)

This reuses the path the CoCalc connector already uses
(`project-host/codex/codex-project.ts`, `createProjectCliTokenLease`). At the
start of each agent turn, the host asks the hub for that turn's connector
credentials. It writes each one to a private file in the project's runtime
directory (mode 0600), renews it every minute, and deletes it when the turn
ends.

New for CLI connectors:

1. **Turn issuance.** The hub returns a short-lived access token for each
   connector this agent is granted (GitHub, Cloudflare), next to the CoCalc
   connector secret. Refresh tokens never leave the hub.
2. **Delivery.** `gh` reads `GH_TOKEN` and `cf` reads `CLOUDFLARE_API_TOKEN`;
   neither reads a token file. The lease directory gets two tiny wrappers,
   `gh` and `cf`, placed first on the turn's `PATH`. Each reads the current
   token from its file and runs the real CLI with the variable set. Because
   the file is read at every invocation, long jobs keep working across
   rotation.
3. **git.** Pushing to GitHub uses a credential helper set through
   `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` in the turn's
   environment. It reads the same token file and is limited to
   `https://github.com`. The user's `~/.gitconfig` is never touched.
4. **Discoverability.** The turn prompt lists the connectors enabled for that
   turn, with one line each ("`gh` is signed in as @user; repositories: …",
   "`cf` is signed in to account …"). The skill gets a Connectors section.
   Lesson from agent messaging: authority an agent doesn't know about is
   useless.

Honest boundary (as for CoCalc access today): during a turn, other code and
collaborators in that agent's project can use the turn's token. The UI says
so. Protection is that tokens are short-lived, scoped, revocable, and absent
between turns, and that the refresh token never enters the project.

## GitHub

**Sign-in:** a CoCalc GitHub App with the device flow. The user gets a code
and approves it on github.com, the same UX as Claude and Codex sign-in. GitHub
App user tokens expire after 8 hours and come with a refresh token. Unlike a
classic OAuth app, a GitHub App only reaches the repositories where you
installed it, with the permissions the app requests.

**Identity (decision 1):**
- **A. Act as you (recommended).** User-to-server tokens. Commits, PRs and
  comments appear as you, exactly like `gh` on your laptop. Access is the
  intersection of your own access and the repositories where the app is
  installed.
- **B. Act as the app ("CoCalc[bot]").** Installation tokens, which can be
  narrowed per agent to specific repositories and permissions. Clear
  attribution, but PRs aren't "yours", and some workflows (reviews, protected
  branches) behave differently.

Per-agent scope in v1: on/off, with the repository set chosen on GitHub's
install screen. Per-agent repository narrowing can come later. With A it
would be enforced through the wrapper and helper, not by GitHub itself, so
it would be advisory.

**Operator setup (decision 2):** someone creates the "CoCalc" GitHub App
under the sagemathinc org with:
- device flow enabled and expiring user tokens;
- permissions: Contents RW, Pull requests RW, Issues RW, Metadata R,
  Workflows RW (optional);
- its client id and client secret in site settings (the secret is needed to
  refresh user tokens).

Self-hosted sites register their own app.

## Cloudflare

**Sign-in (decision 3), recommended: `cf`'s own OAuth device flow**, run by
CoCalc. The same precedent as Codex subscriptions, which use OpenAI's public
client id and refresh centrally (`server/external-credentials/
codex-subscription-refresh.ts`). The user picks what the agent may do from
presets that map to `cf` scopes:

| Preset | Scopes |
|---|---|
| Workers & sites | `workers:write workers_scripts:write workers_routes:write zone.read dns_records:edit` |
| R2 storage | `workers-r2.read workers-r2.write workers-r2-bucket-item.read workers-r2-bucket-item.write` |
| DNS | `zone.read dns_records:read dns_records:edit` |
| Always | `account:read user:read` |

We never request `cf`'s default (~481 scopes, the whole account). The access
token is about one hour long and is refreshed on the hub with the refresh
token. Fallback: paste a Cloudflare API token created in the dashboard, for
sites or users who prefer that.

`cf` behaviours the prompt and skill should mention (hands-on notes from
@sagebrush-claude):
- every change command supports `--dry-run`, so agents should show the dry run
  and ask before running the real command;
- set `NO_COLOR=1` and `CF_SEND_TELEMETRY=false`, and filter the
  `-- START/END CF API REQUEST` blocks before parsing JSON;
- lists paginate;
- `r2 buckets lifecycle update` replaces all rules.

## Records

- **Connection** (account level): the external credential store, with new
  kinds `github-app-user` and `cloudflare-oauth`. The payload holds the
  refresh token; metadata holds the GitHub login and repositories, or the
  Cloudflare account and chosen presets. Stored per account at its home bay,
  like Claude/Codex subscriptions.
- **Grant** (per agent): a generic table
  `agent_connector_grants(account_id, agent_id, source_project_id, connector,
  connection_id, enabled, scope jsonb, revision)`. Same compare-and-swap,
  fresh-auth and revocation rules as the CoCalc access config; disabling or
  removing revokes active turn tokens. The CoCalc connector keeps its own
  table for now.

## UI

- **Settings → Connectors:**
  - a GitHub section (Connect, signed-in account, repositories link,
    Reconnect, Disconnect, agents using it);
  - a Cloudflare section (Connect with presets, account, Reconnect,
    Disconnect, agents using it).
- **Composer connectors list:** GitHub and Cloudflare rows with status ("Off",
  "@user", "Account · Workers"). Clicking opens a small per-agent dialog: an
  on/off switch, plus a link to connect first if you haven't. The chip counts
  them.

## Slices

1. **Shared foundation:**
   - the grant table and API;
   - turn issuance of connector tokens;
   - the host-side wrappers, git helper and prompt lines;
   - tested end to end with a manually inserted "pasted token" connection.
2. **Cloudflare:** device-flow sign-in with presets, refresh, UI. Usable
   right away on lite4b.
3. **GitHub:** once the app exists. Device flow, refresh, UI, git push.
4. Security review by @lite4-review of each slice before merge.

## Decisions (William, 2026-10-05)

1. GitHub: agents act as the user (option A, user-to-server tokens).
2. GitHub App: setup instructions are the admin docs page `admin/github-connector` (src/packages/docs, admin-only), written for any self-hosted site; site settings `github_connector_client_id`, `github_connector_client_secret`, `github_connector_app_url`. William creates cocalc.ai's app.
3. Cloudflare: sign in through `cf`'s own OAuth device flow with presets; paste-an-API-token as fallback.

## Decision after security review (William, 2026-10-05)

Expiring provider tokens only. Pasted long-lived tokens are removed: during a
turn any project code could copy one and use it indefinitely, and a host crash
can leave the file behind (review finding F2). Users who want a long-lived
token can run `gh auth` themselves in the meantime. GitHub: GitHub App device
flow, 8 h user tokens refreshed by the hub. Cloudflare: cf OAuth device flow
with scope presets.
