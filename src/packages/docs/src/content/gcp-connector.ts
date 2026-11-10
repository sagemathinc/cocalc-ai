/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const GCP_CONNECTOR_BODY = String.raw`
> **Planned design — this connector is not available yet.** This page
> describes how the Google Cloud connector is designed to work and how it is
> designed to be secured. Parts of it, including CoCalc's side described
> below, do not exist yet. The page will be updated when the connector is
> released.

## Short answer

The Google Cloud connector will let your CoCalc agents run \`gcloud\` (and other
Google Cloud tools) in **your** Google Cloud project. They will act as **one
service account that you create**, with **the roles you choose**, plus one
read-only permission used to verify the project.

The connector is designed never to store a long-lived Google credential, in
CoCalc or in your CoCalc project:
- Agents receive short-lived access tokens, valid for at most 15 minutes.
- They receive them only while they are working for you.
- You can cut off access at any time, from CoCalc or from Google Cloud.

If you only want to use \`gcloud\` yourself in your own project, you can still
run \`gcloud auth login\`. The comparison at the end of this page explains when
that is the better choice.

## How it works

There are two sides, and they are set up separately.

**CoCalc's side (the same for every user).**
- **The signing key.** CoCalc will sign short identity statements ("this request
  comes from agent X of account Y, for connection Z") with a key held in
  Google Cloud KMS. The key will be kept in hardware: nobody, including
  CoCalc's operators, can export or copy it. It can only be used to sign,
  through an API call that CoCalc's setup configures Google Cloud to log
  (as a Data Access audit log entry).
- **Separate projects.** The key is designed to live in a dedicated Google
  Cloud project that contains nothing else and runs no virtual machines.
- **The broker.** Only the identity of a small token broker will be granted
  use of the key. The broker will run in a second, separate project.
  Separate projects will be used for staging and for production.
- **Monitoring.** Changes to who may use the key, and security-sensitive
  changes to the broker's identity or to its machine's access settings, will
  raise an alert to CoCalc's operations team.

**Your side (set up once per connection, in your project).**
A guided setup creates, in a Google Cloud project you choose:
- a **workload identity pool** with **one provider** that trusts CoCalc's
  signing key. It accepts only statements for **your** CoCalc account and
  **this** connection;
- **one service account**, with the roles you pick, plus a small custom
  role with one read-only permission (\`resourcemanager.projects.get\`).
  CoCalc uses it only to confirm which project it is talking to; it can't
  read your project's access policy or change anything;
- **one binding** that lets this connection, and no other CoCalc identity,
  act as that service account.

Setup never creates a key in your project. It never gives any role to a
CoCalc-owned service account there.

**When an agent needs Google Cloud:**
1. The broker will check that the connection is yours and that the grant is
   turned on (at its current revision). It will also check that the agent is
   working for you right now.
2. The broker will sign a statement that is valid for at most 5 minutes, and
   record the signature in its log.
3. Google exchanges that statement for an access token of your service
   account, valid for at most 15 minutes.
4. The token will be placed in the agent's project as a file that \`gcloud\`
   reads. It is renewed while the agent keeps working, and stops being
   renewed when the work ends or you turn the connection off.

## What CoCalc can and cannot do in your project

- **It can do exactly what your service account's roles allow, and nothing
  else.** Choose the smallest roles that do the job. For example, use a
  read-only role if agents only need to look.
- **CoCalc refuses the most dangerous permissions.** CoCalc's connection
  setup binds the roles you choose, plus the one-permission read-only role it
  needs to verify your project. At setup, and again whenever the grant
  changes or is turned back on, CoCalc refuses the connection if the service
  account can act as service accounts, create tokens or keys for them,
  change your project's access policy, set organization policies through
  the older Organization Policy permission (\`orgpolicy.policy.set\`), edit
  custom roles, or change identity pools.
  - This means a connection can't be used for project IAM administration, or
    with roles such as Owner or Editor, which can act as service accounts.
  - At first setup only, the setup script also looks inside the roles you
    request and refuses any role that can change the access policy of an
    individual resource, such as Storage Admin. CoCalc doesn't check this
    again later: if such a role is granted afterwards, the connection keeps
    working.
  - CoCalc's checks with Google look at permissions granted on your project
    (including those inherited from your organization) and on the
    connection's own service account. A permission granted directly on one
    other resource, such as a single other service account or bucket, isn't
    checked.
  - The newer Organization Policy permissions
    (\`orgpolicy.policies.create\`, \`update\` and \`delete\`) aren't
    checked. A custom role that holds only those can change the organization
    policies set on your project without being refused.
- **CoCalc acts only through your service account.** Setup never grants any
  role to a CoCalc-owned service account in your project. CoCalc acts only
  through the one service account you create, with the roles you choose.
- **CoCalc checks with Google, not just with its own setup script.** Before
  a connection is turned on, CoCalc asks Google directly whether the new
  identity holds any of the permissions CoCalc refuses at every check
  (listed above). If it does, or the answer is unclear, the connection stays
  off. The same check runs again whenever the grant changes or is turned
  back on.

**What this does not guarantee.** These checks run at setup, whenever the
grant changes, and when the connection is turned back on.
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
  the binding on the service account. New tokens stop at once, whatever
  happens on CoCalc's side. A token already issued stays usable until it
  expires, at most 15 minutes later.
- **Narrow it:** remove roles from the service account at any time.

## Seeing what happened

- **In your project:** changes the agents make (Admin Activity) are always
  logged in your Cloud Audit Logs as the service account. Reads, and each
  time a token is issued, are logged only if you enable Data Access audit
  logs for those services (for token issuance: the Security Token Service
  and IAM Credentials APIs).
- **On CoCalc's side:** the broker will record every signature it makes, and
  for which account, agent and connection.

## Compared with \`gcloud auth login\`

You can always run \`gcloud auth login\` in a CoCalc project terminal. It signs
\`gcloud\` in as **you**.

|  | Google Cloud connector | \`gcloud auth login\` in a project |
|---|---|---|
| Acts as | one service account you create | you, with all your permissions, in every project you can reach |
| Permissions | only the roles you give it (plus one read-only permission to identify the project); the most dangerous IAM permissions refused at setup, revision and re-enable | everything your Google account can do, including IAM administration |
| Credential in the project | a token valid for at most 15 minutes, renewed only while an agent works | a long-lived refresh token stored in the project's files until you revoke it |
| Who can use it | anyone who can run code in that CoCalc project while an agent is working | anyone who can run code or read files in that project, at any time, until you revoke it |
| Revoke | one switch in CoCalc, or in Google Cloud; at most 15 more minutes of use | revoke the sign-in in your Google account; the stored credential works until then |
| Audit | the service account in your audit logs, plus CoCalc's signature log | your own user account in your audit logs |
| Setup | a one-time guided setup; needs permission to create a pool, provider and service account in your project | none |
| Works for project IAM administration | no, by design | yes |

**Use the connector when** agents should work in Google Cloud for you,
especially unattended or in a shared project, or when you want access you can
limit, see and switch off.

**Use \`gcloud auth login\` when:**
- you are working by yourself in a project only you use;
- you need your own full permissions, for example for IAM or organization
  administration;
- you can't create the pool, provider and service account in your Google
  Cloud project.

Sign out with \`gcloud auth revoke\` when you are done. Remember that until
then, anyone who can use that project can use your login.
`;
