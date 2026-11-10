/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const GCP_CONNECTOR_BODY = String.raw`
## Short answer

The Google Cloud connector lets your CoCalc agents run \`gcloud\` (and other
Google Cloud tools) in **your** Google Cloud project. They act as **one
service account that you create**, with **only the roles you choose**.

No long-lived Google credential is ever stored in CoCalc or in your CoCalc
project:
- Agents receive short-lived access tokens, valid for at most 15 minutes.
- They receive them only while they are working for you.
- You can cut off access at any time, from CoCalc or from Google Cloud.

If you only want to use \`gcloud\` yourself in your own project, you can still
run \`gcloud auth login\`. The comparison at the end of this page explains when
that is the better choice.

## How it works

There are two sides, and they are set up separately.

**CoCalc's side (the same for every user).**
- **The signing key.** CoCalc signs short identity statements ("this request
  comes from agent X of account Y, for connection Z") with a key held in
  Google Cloud KMS. The key is kept in hardware: nobody, including CoCalc's
  operators, can export or copy it. It can only be used to sign, through an
  API call that Google logs.
- **Separate projects.** The key lives in a dedicated Google Cloud project
  that contains nothing else and runs no virtual machines.
- **The broker.** The only program allowed to use the key is a small token
  broker, which runs in a second, separate project. Separate projects are
  used for testing and for production.
- **Monitoring.** Changes to who may use the key, or to the broker's
  machine, raise an alert to CoCalc's operations team.

**Your side (set up once per connection, in your project).**
A guided setup creates, in a Google Cloud project you choose:
- a **workload identity pool** with **one provider** that trusts CoCalc's
  signing key. It accepts only statements for **your** CoCalc account and
  **this** connection;
- **one service account**, with the roles you pick, plus a small custom
  role with one read-only permission (\`resourcemanager.projects.get\`).
  CoCalc uses it only to confirm which project it is talking to; it can't
  read your project's access policy or change anything;
- **one binding** that lets this connection, and nothing else, act as that
  service account.

Setup never creates a key in your project. It never gives any role to a
CoCalc-owned service account there.

**When an agent needs Google Cloud:**
1. The broker checks that the connection is yours and that the grant is
   turned on (at its current revision). It also checks that the agent is
   working for you right now.
2. The broker signs a statement that is valid for at most 5 minutes, and
   records the signature in its log.
3. Google exchanges that statement for an access token of your service
   account, valid for at most 15 minutes.
4. The token is placed in the agent's project as a file that \`gcloud\` reads.
   It is renewed while the agent keeps working, and stops being renewed when
   the work ends or you turn the connection off.

## What CoCalc can and cannot do in your project

- **It can do exactly what your service account's roles allow, and nothing
  else.** Choose the smallest roles that do the job. For example, use a
  read-only role if agents only need to look.
- **Setup refuses dangerous roles.** CoCalc's connection setup binds the
  roles you choose, plus the one-permission read-only role it needs to
  verify your project. At setup, and again whenever the grant changes or is turned back
  on, it refuses any role that could manage service accounts, keys, custom
  roles, identity pools or access policies in your project.
  - This means a connection can't be used for IAM administration, or for
    roles such as Owner, Editor or Storage Admin, which include
    policy-changing permissions.
- **CoCalc acts only through your service account.** Setup never grants any
  role to a CoCalc-owned service account in your project. CoCalc acts only
  through the one service account you create, with the roles you choose.
- **CoCalc checks with Google, not just with its own setup script.** Before
  a connection is turned on, CoCalc asks Google directly whether the new
  identity holds any of the refused permissions. If it does, or the answer
  is unclear, the connection stays off. The same check runs again whenever
  the grant changes or is turned back on.

**What this does not guarantee.** These checks run at setup and at re-enable.
- **Later changes.** If someone later gives the service account more power in
  your project (or your organization does), CoCalc will not necessarily
  notice right away. Treat that service account like any other: only you
  decide its roles.
- **Tokens already issued.** Turning a connection off stops new tokens at
  once. CoCalc can't recall a token that was already issued; it stays usable
  until it expires, at most 15 minutes later.
- **Code in your project.** While an agent works, code running in that CoCalc
  project can use the current token. That includes code the agent runs.
  Share the project only with people you trust to act as that service
  account.

## How to stop it

Any one of these is enough:
- **In CoCalc:** turn the connection off. New tokens stop immediately.
- **In Google Cloud:** delete or disable the provider or the pool, or remove
  the binding on the service account. This cuts CoCalc off completely,
  whatever happens on CoCalc's side.
- **Narrow it:** remove roles from the service account at any time.

## Seeing what happened

- **In your project:** every action the agents take appears in your Cloud
  Audit Logs as the service account. If you enable Data Access audit logs
  for the Security Token Service and IAM Credentials APIs, Google also
  records each time a token was issued. Data Access logs are also what show
  read operations.
- **On CoCalc's side:** the broker records every signature it makes, and
  for which account, agent and connection.

## Compared with \`gcloud auth login\`

You can always run \`gcloud auth login\` in a CoCalc project terminal. It signs
\`gcloud\` in as **you**.

|  | Google Cloud connector | \`gcloud auth login\` in a project |
|---|---|---|
| Acts as | one service account you create | you, with all your permissions, in every project you can reach |
| Permissions | only the roles you give it (plus one read-only permission to identify the project); dangerous roles refused at setup and re-enable | everything your Google account can do, including IAM administration |
| Credential in the project | a token valid for at most 15 minutes, renewed only while an agent works | a long-lived refresh token stored in the project's files until you revoke it |
| Who can use it | agents working for you, and code they run during that work | anyone who can run code or read files in that project, at any time, until you revoke it |
| Revoke | one switch in CoCalc, or in Google Cloud; at most 15 more minutes of use | revoke the sign-in in your Google account; the stored credential works until then |
| Audit | the service account in your audit logs, plus CoCalc's signature log | your own user account in your audit logs |
| Setup | a one-time guided setup; needs permission to create a pool, provider and service account in your project | none |
| Works for IAM or policy administration | no, by design | yes |

**Use the connector when** agents should work in Google Cloud for you,
especially unattended or in a shared project, or when you want access you can
limit, see and switch off.

**Use \`gcloud auth login\` when:**
- you are working by yourself in a project only you use;
- you need your own full permissions, for example IAM or organization
  administration, which the connector refuses by design;
- you can't create the pool, provider and service account in your Google
  Cloud project.

Sign out with \`gcloud auth revoke\` when you are done. Remember that until
then, anyone who can use that project can use your login.
`;
