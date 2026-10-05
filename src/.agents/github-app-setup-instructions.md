# Create the "CoCalc" GitHub App (for the GitHub connector)

About 10 minutes. You need owner rights on the sagemathinc organization.
Nothing here gives the app access to any repository by itself: each user later
installs it on the repositories they choose, and agents act as that user.

## 1. Start a new app

Go to https://github.com/organizations/sagemathinc/settings/apps and click
**New GitHub App**.

## 2. Basic information

- **GitHub App name:** `CoCalc`. Names are global on GitHub, so if it's taken,
  use `CoCalc Agents`. Users see this name when they approve sign-in.
- **Description** (optional): "Lets your CoCalc agents use git and gh with your
  GitHub account."
- **Homepage URL:** `https://cocalc.ai`

## 3. Identifying and authorizing users

- **Callback URL:** `https://cocalc.ai/auth/github/callback`. The connector
  uses the device flow and won't call this URL, but GitHub requires one.
- **Expire user authorization tokens:** checked (the default). Tokens then
  last 8 hours, and CoCalc refreshes them.
- **Request user authorization (OAuth) during installation:** unchecked.
- **Enable Device Flow:** **checked**. This is the "approve a code in your
  browser" sign-in.

## 4. Post installation

- **Setup URL:** leave empty.
- **Redirect on update:** unchecked.

## 5. Webhook

- **Active:** **unchecked**. The connector doesn't need webhooks.

## 6. Permissions

Repository permissions (leave everything else "No access"):

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | clone, push, create branches |
| Pull requests | Read and write | `gh pr create`, comments, reviews |
| Issues | Read and write | `gh issue` |
| Metadata | Read-only | mandatory |
| Actions | Read-only | `gh run list/view`: see CI results |
| Checks | Read-only | `gh pr checks` |
| Commit statuses | Read-only | CI status on commits |
| Workflows | Read and write | optional: lets agents change files in `.github/workflows` (push fails without it) |

Account permissions:

| Permission | Access | Why |
|---|---|---|
| Email addresses | Read-only | optional: lets CoCalc set a matching git author email |

Organization permissions: none.

## 7. Where can this GitHub App be installed?

**Any account**, so every CoCalc user can install it on their own repositories.

Click **Create GitHub App**.

## 8. After creating it

On the app's settings page:

1. Note the **Client ID** (it starts with `Iv23`) and the app's **public link**
   (`https://github.com/apps/<slug>`).
2. Under **Client secrets**, click **Generate a new client secret** and copy it
   at once. GitHub shows it only once. CoCalc needs it to refresh user tokens.
3. You do **not** need a private key: agents act as you, so CoCalc never
   authenticates as the app itself.

Send me the Client ID and the public link; they aren't secret. Keep the
**client secret** in your password manager. Don't paste it into chat: it goes
into CoCalc's admin site settings (a new GitHub App section that's part of this
work), from where only the hub uses it.

## 9. Try it on a repository

Install the app on one test repository: public link → **Install** →
sagemathinc → **Only select repositories**. When the connector is ready,
"Connect GitHub" asks you to approve a code at https://github.com/login/device,
and agents can then use `gh` and `git push` on the repositories where the app
is installed, as you.

## Good to know

- Access is always the intersection of the repositories where the app is
  installed and your own permissions. An agent can never do more than you can.
- Revoke at any time: Disconnect in CoCalc, or github.com → Settings →
  Applications → Authorized GitHub Apps → CoCalc → Revoke.
- Self-hosted CoCalc sites create their own app with the same settings.
