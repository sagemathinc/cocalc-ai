# Self-Hosted Provider Bootstrap UX Design

Status: design note, recorded on 2026-05-08

This document records the current conclusions about operator setup UX for
self-hosted Launchpad-style deployments that need to configure external cloud
providers.

It exists because the current Nebius, GCP, and especially Cloudflare setup
paths are materially more error-prone than they need to be.

## Scope And Release Status

This work is important for self-hosted Launchpad and later operator adoption.

It is **not** a blocker for the first public release of `cocalc-ai.com`, which
is a SaaS release. We should not let this expand first-release scope.

This should instead be treated as:

- an important self-hosted / Launchpad product-quality track,
- a foundation for later Cloudflare email support,
- and a clear post-release or parallel track once SaaS blockers are done.

## Problem Statement

Current operator setup flows are uneven:

- Nebius and GCP already have a much better direction:
  - install/auth a CLI,
  - run one command,
  - feed results back into the product.
- Cloudflare currently relies on a long browser wizard with many manual steps,
  screenshots, and copy/paste.

The main failure modes are:

- large secret blobs appearing in terminal scrollback,
- large secret blobs sitting in the clipboard,
- brittle copy/paste of wrapped or partially selected text,
- users needing to infer which part of command output matters,
- and excessive manual Cloudflare dashboard work.

This is bad for robustness and bad for trust, especially for self-hosted users.

## Product Goal

The target UX is:

- GCP: install/auth CLI, paste one line, browser receives and validates the
  result
- Nebius: install/auth CLI, paste one line, browser receives and validates the
  result
- Cloudflare: ideally no long manual wizard; instead a short bootstrap flow
  where the browser or server automates almost everything after one initial
  trust grant

The user should end up with:

- minimal copy/paste,
- no large secret payloads exposed unnecessarily,
- clear validation before settings are applied,
- and a reliable flow that works from remote servers and SSH sessions.

## Shared Design Principles

### 1. Browser remains the authority

The browser starts the setup flow, shows current draft state, and is the place
where the operator reviews and clicks `Apply`.

### 2. Use short-lived setup challenges

The browser should mint a short-lived, single-use setup challenge for each
wizard flow. The challenge is scoped to the provider and setup intent.

### 3. Avoid raw secret copy/paste where possible

For CLI-based providers, the script should upload structured results directly
to the server instead of printing a large JSON blob that the operator then
copies back into the browser.

### 4. Keep a manual fallback

A fully manual paste mode should remain available for:

- disconnected environments,
- very locked-down hosts,
- or debugging / support.

### 5. Show parsed preview before persisting

Uploaded or discovered data should land in temporary draft state first. The UI
should show a parsed preview and validation result before anything is saved to
durable settings.

### 6. Remote-server friendly only

No setup flow may depend on a localhost callback server or assumptions that the
browser and CLI run on the same machine.

## GCP And Nebius Direction

For GCP and Nebius, the right shape is a one-line script plus direct upload.

### Flow

1. Browser wizard starts a setup challenge.
2. Browser shows a one-line command that includes a short-lived upload token.
3. Operator runs that command on any machine with the provider CLI installed
   and authenticated.
4. Script gathers the required config and uploads it directly to Launchpad.
5. Browser polls challenge status and shows a parsed preview.
6. Operator clicks `Apply`.

### Why this is preferred

It preserves the best part of the current GCP/Nebius model:

- the provider-specific auth remains with the provider CLI,
- the operator can run the command on a remote machine,
- and the actual product UX is reduced to one command plus a final review.

It also removes the worst part:

- large secrets or JSON blobs should not be printed into terminal output unless
  the operator explicitly chooses the manual fallback path.

### Data-handling rules

The script should:

- print only minimal status output,
- not echo the raw credential payload on success,
- not require the operator to copy large JSON output,
- and fail clearly when upload or provider discovery fails.

The server should:

- accept only a strict schema with size limits,
- store the uploaded payload only as temporary draft data until `Apply`,
- and invalidate setup tokens quickly.

## Cloudflare Direction

Cloudflare is different enough that we should not force it into the same model.

### Main conclusion

The likely best V1-quality operator UX for Cloudflare is **not** a CLI-first
flow. It is:

- a browser bootstrap-token flow,
- followed by server-side Cloudflare API automation.

### Why

Cloudflare setup is fundamentally account/zone/browser oriented:

- select the correct account,
- select or infer the correct zone,
- configure DNS/tunnel/R2 behavior,
- and later possibly configure email.

Trying to force all of that into a CLI-first path is possible, but it is not
the most natural or lowest-friction solution.

### Recommended Cloudflare flow

1. Browser wizard asks for the external domain.
2. Operator pastes a bootstrap Cloudflare token once.
3. Launchpad uses Cloudflare APIs to:
   - discover accounts and zones,
   - infer or let the operator choose the correct account and zone,
   - create durable Launchpad-specific token(s),
   - enable visitor location headers,
   - create or validate R2 credentials,
   - and validate the final configuration.
4. Browser shows a parsed preview and capability status.
5. Operator clicks `Apply`.
6. Bootstrap token is discarded.

### Why this is much better than the current wizard

It removes the most fragile Cloudflare steps:

- manually locating account id,
- manually creating multiple token surfaces via screenshots,
- manually toggling managed transforms,
- manually creating and copying R2 credentials,
- and repeatedly switching between browser tabs and copy buffers.

### Why this is better than a Cloudflare CLI primary path

Cloudflare has been improving its CLI, but that should not be our main release
foundation here. Direct API automation is the more stable and product-shaped
path for Launchpad.

We may still add a CLI helper later, but the core design should be:

- browser bootstrap token,
- server automation,
- browser preview and apply.

## Cloudflare Capability Model

We should treat Cloudflare setup as one provider integration with multiple
capabilities, not as a tunnel-only wizard.

Suggested capability surface:

- `dns_ok`
- `tunnel_ok`
- `r2_ok`
- `visitor_headers_ok`
- `email_ok`

This matters because we explicitly want to add Cloudflare-backed email sending
later. That future work should extend the same provider integration, not invent
an unrelated second setup flow.

## Relationship To Existing Code

This design builds on code that already exists:

- GCP and Nebius wizards already use script-first setup concepts.
- Cloudflare tunnel + DNS automation already exists in the backend.
- The current manual Cloudflare wizard is already debugged and useful as a
  fallback path.
- CLI auth challenge/poll/redeem patterns already exist and are a good model
  for short-lived setup challenges.

So this is not a greenfield concept. The main work is reshaping the operator
UX and challenge flow.

## Recommended Implementation Order

When this work is prioritized, the recommended order is:

1. Nebius upload challenge flow
2. GCP upload challenge flow
3. Cloudflare bootstrap-token automation flow
4. Later: Cloudflare email capability on top of the same provider integration

Reason:

- Nebius and GCP are the easiest wins because they already fit the script model
- Cloudflare needs more design and API integration work, but offers the
  biggest UX payoff once done

## Non-Goals

This design does not imply:

- expanding first public SaaS release scope,
- replacing the current manual Cloudflare wizard immediately,
- or requiring Cloudflare CLI to be the source of truth for setup.

## Summary

The conclusions are:

- GCP and Nebius should move toward short-lived upload challenges and direct
  script-to-server submission.
- Cloudflare should move toward a bootstrap-token browser flow with direct
  server-side API automation.
- Manual copy/paste flows should remain available as a fallback, not the
  primary path.
- This work is important for self-hosted Launchpad usability, but is not a
  blocker for the first public SaaS release of `cocalc-ai.com`.
