/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const WEB_BROWSER_BODY = String.raw`
## A browser you and your agents share

A CoCalc web browser is a real Chromium browser that belongs to your project.
Agents drive it; you watch it live and can take over at any moment, then hand
it back. It shows up in two places:

- **In an agent chat**, when an agent starts a browser for a task, as a live
  card next to the conversation.
- **As a file ending in \`.browser\`**, a browser of your own that keeps its
  logins and cookies. Open it like any document, split it into frames, and
  point agents at it.

Most of what people do on a computer happens in a web browser, so an agent
that can browse alongside you can help with far more than an agent limited to
files and terminals. The hard parts of the web (signing in, two-factor codes,
CAPTCHAs, payments, judgment calls) stay with you; the tedious parts go to the
agent.

## What this unlocks

- **Test the web app you are building.** Start a development server in the
  project, then have an agent open \`localhost:5173\`, click through the
  signup flow, fill in forms, and report what broke, with screenshots. You
  watch it happen and can step in.
- **Reproduce a bug report.** Paste the steps a user sent and let the agent
  follow them in the browser while you watch for the moment it goes wrong.
- **Work with sites that have no API.** Collect a table from a web page, read
  documentation that needs JavaScript, export settings from a dashboard, or
  fill in a long web form from data in a spreadsheet.
- **Sign in once, then delegate.** You sign in to a service in the browser
  (a cloud console, a journal through your library, a learning platform); the
  agent then does the repetitive work in that session. Your password never
  goes into the chat.
- **Use your own network and accounts.** Some sites refuse visitors from cloud
  servers, and some resources are only reachable from your institution's
  network or VPN. Run the browser on your computer (see below) and the agent
  works through your connection.
- **Teach and demonstrate.** Students and colleagues can watch an agent work
  through a site step by step, take over to try something themselves, and
  hand it back.

## Open a browser

1. Open the project.
2. Click **New** and choose **Web Browser**, or create a file ending in
   \`.browser\`.
3. Type an address or search words in the address bar.

A browser file opens with **you driving**, so you can use it right away. Each
frame of a split shows its own tab of the same browser: same logins, separate
pages and scroll positions. Open more tabs with **+**.

## Take over and hand back

The bar under the address bar shows who is driving:

- **The agent is driving**: your clicks and typing are ignored, and the
  browser says so if you try. Click **Take over** to drive.
- **You are driving**: the agent's actions wait until you click **Hand back to
  agent**. If the agent is waiting for you, the bar tells you.
- An agent can ask you to take over, for example to sign in. Its request
  appears in the bar; when you hand back, the agent continues.

If you close the browser while you are driving, it is handed back to the
agent after a short delay, so an agent never waits on a browser nobody is
looking at.

## Ask an agent to use it

In a \`.browser\` file, click **Agent** in the title bar and describe the task,
for example "open my app on localhost:8000 and check that signing in to it
works". The agent is told which browser to use.

Agents use the browser with the CoCalc CLI, which needs no extra libraries:

~~~sh
cocalc project browser start --browser ~/work.browser --url https://example.com
cocalc project browser goto --browser ~/work.browser https://example.com/docs
cocalc project browser text --browser ~/work.browser
cocalc project browser click --browser ~/work.browser 'button[type=submit]'
cocalc project browser type --browser ~/work.browser 'hello' --selector '#q'
cocalc project browser press --browser ~/work.browser Enter
cocalc project browser screenshot --browser ~/work.browser --out /tmp/page.png
cocalc project browser ask-human --browser ~/work.browser --message "Please sign in" --wait
~~~

Without \`--browser\`, the commands use the project's chat browser. For heavier
automation, \`start\` also prints a Chrome DevTools Protocol endpoint that
Playwright, Puppeteer, or chrome-devtools-mcp can connect to.

## Run it on your computer

A browser can run in Chrome on your own computer instead of in the project.
Sites then see your network and your logins, which helps when a site blocks
cloud servers or when a resource is only reachable from your network.

1. In the browser, switch **Runs in the project** to **Runs on my computer**.
2. Install the CoCalc CLI on your computer once; the browser shows the
   command.
3. Run the command it shows, for example:

   ~~~sh
   cocalc project browser connect -w <project> --browser /home/user/work.browser --api https://cocalc.ai
   ~~~

A Chrome window opens with a profile of its own for that file, kept on your
computer so you only sign in once. It never uses your everyday Chrome profile.
The browser stays connected while the command runs; in CoCalc you see a small
preview, and you use the Chrome window itself. Close the window or press
Ctrl-C to disconnect; the file then waits for your computer again.

Some sites (X, for example) refuse to sign in to a browser that tools can
control. Add \`--sign-in\`: Chrome first opens without any automation so you
can sign in; close it, and it reopens connected, still signed in.

## Picture quality

The quality menu next to the address bar sets how the browser is shown:
**Balanced** (the default) and **Sharp** send a crisp picture once the page is
still, **Sharp** losslessly; **Fast** uses the least bandwidth. The setting is
remembered on each device.

## Shut it down

Click **Shut down** in the address bar to stop a browser. Agents cannot use it
until someone starts it again. A \`.browser\` file keeps its logins; the chat
browser starts fresh next time.

## Projects without internet access

Free projects have no internet access, so their browser can only open pages
served by the project itself, such as a development server on \`localhost\`.
The browser says so and links to the membership page. A \`.browser\` file can
also run on your computer, which uses your network.

## Security and privacy

- Everything in the project can control its browsers: your agents, and
  collaborators and their agents. Sign in only to accounts you are willing to
  share with the project.
- A browser on your computer is reachable from the project only while the
  \`connect\` command runs, and only with that file's own profile.
- Each \`.browser\` file has its own profile. Use separate files for separate
  accounts.

## Troubleshooting

- **"Waiting for your computer"**: the browser is set to run on your computer
  and the \`connect\` command is not running. Run it, or switch back to
  **Runs in the project**.
- **A site refuses to sign in**: run \`connect\` with \`--sign-in\` and sign in
  before the browser is connected.
- **Clicks or typing do nothing**: someone else is driving; take over first.
- **The page looks soft**: choose **Sharp** in the quality menu.
`;
