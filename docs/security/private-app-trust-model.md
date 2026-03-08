# Private App Trust Model

This note records the current security posture for private managed apps on
project-hosts.

## Decision

CoCalc uses a **same-project trust model** for private managed apps.

If a collaborator opens a private app in a project, that app is treated as
having the same effective trust level as arbitrary code run inside that
project. This is the same basic trust boundary users already accept when they:

- run code from a Jupyter notebook,
- execute shell commands in a terminal,
- start arbitrary services inside the project,
- open project-owned HTML/JS that can talk to local project services.

Private managed apps are therefore **not** treated as an internal sandbox
against other code in the same project.

## Threat Model

The important security boundary is **between projects**, not between one app
and another component inside the same project.

Under this model, an untrusted or compromised private app may already be able
to:

- read and exfiltrate project files,
- modify project files,
- talk to project-local services,
- act with the same project-level authority as other user-run code in that
  project.

What we still must prevent is accidental escalation beyond that boundary, such
as:

- access to private apps in a different project on the same host,
- direct exposure of project-host auth/session credentials to upstream apps,
- leaking unnecessary account-specific metadata from project-host endpoints.

## Hardening That Remains Required

Even with the same-project trust model, CoCalc still enforces these
defense-in-depth protections:

- project-host HTTP session cookies are scoped to `/${project_id}` instead of
  `Path=/`,
- project-host auth/session cookies are stripped before proxying traffic
  upstream to managed apps,
- project-host bootstrap bearer auth is stripped after validation and not sent
  to upstream apps,
- project-host `/customize` no longer exposes `account_id`,
- public apps use separate public hostnames, so browser same-origin access to
  the main site is not the relevant risk there.

These protections are required because the trust model is **same-project**, not
**same-host** and not **site-wide**.

## What Is Considered Acceptable

Under this model, it is acceptable for a private app to read project-scoped
project-host metadata on the same origin, provided that metadata does not
expose cross-project or site-wide credentials.

For example, a private app being able to fetch project-scoped host metadata is
not treated as a vulnerability by itself. The reason is that the app already
has project-level authority through normal project execution semantics.

## What Would Change This Decision

We would revisit this model if CoCalc introduces:

- stronger internal sandboxing inside projects,
- per-app capability isolation inside a project,
- sensitive per-user or site-wide data on project-host endpoints that private
  app JS could read,
- a requirement that private apps be treated as less trusted than notebooks,
  terminals, or other project content.

If any of those become goals, then per-app origin or capability isolation would
need to be revisited.
