# GPUs on the user's own RunPod key

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

`cocalc gpu ...` starts and ends GPU pods on the user's **own** RunPod
account, which they connect in Settings → Connectors. Every pod bills the
user's RunPod balance by the minute, so treat each launch as spending their
money.

## Rules

- **Never ask for, print, store or handle a RunPod API key.** Only the user
  connects one, in Settings. If no key is connected, say so and stop.
- **State the most a launch can cost before launching**: `max_cost_usd`
  from `launch --dry-run`, the GPUs and all disk at list price for the whole
  maximum runtime. Then launch exactly that, with the dry run's `next`
  command: it pins the GPU and adds `--max-cost`, so the launch is refused if
  prices or stock changed, and the pod is terminated at once if RunPod bills
  it above the bound. Launch only what the user asked for.
- **The bound holds only if the pod ends by its maximum runtime. You end
  it:** don't count on CoCalc to terminate it at the deadline. Launch with
  the dry run's `next`, then, before starting any work, set a watcher for a
  few minutes before the `deadline` the launch returned (see Waiting), and
  terminate the pod then if the work isn't done.
- **Always use the shortest sensible `--max-runtime`.**
- **Terminate the pod as soon as the work is done:**
  `cocalc gpu terminate <handle>`.
- **Stop and tell the user, and launch nothing, when you see:**
  - an unknown-pod alert (a pod in their RunPod account that CoCalc didn't
    start);
  - a spend alert, or a key reported as paused;
  - a host-key mismatch from `connect`.
- **Never terminate a pod CoCalc didn't start** (those only appear in
  `pods --all`). If asked to, explain that it isn't managed here and that the
  user can end it in RunPod.
- **Never trust a new host key for a `cc-*` host by hand**: no
  `--trust-new-host`, no editing known_hosts. The pinned key comes only from
  `cocalc gpu connect`.

## Workflow

```bash
cocalc gpu templates                     # built-in starting points
cocalc gpu availability --cloud SECURE   # what is in stock now, cheapest first
cocalc gpu launch --template pytorch-kernel --dry-run   # the GPU, spec, max cost, next
# then run the dry run's `next` exactly as printed: launch, SSH, kernel
cocalc gpu pods                          # the pods CoCalc started
cocalc gpu terminate cc-...              # end it (and its billing)
```

- **`launch --template <id>`:** explicit options override the template
  (`--gpu`, `--max-runtime`, `--count`, `--cloud`, `--disk`, `--env NAME=value`).
  - Without `--gpu`, it picks the cheapest Secure offer in stock with enough
    GPU memory for the template.
  - A kernel template waits for the pod to register its SSH host key (up to
    `--wait`, default 300 s), then registers a Jupyter kernel named
    `reflect-<handle>`. Pick that kernel in a notebook.
  - If the connect step fails, the launch still returns the pod's handle and
    a `connect_error`. The pod is billing: retry with `cocalc gpu connect
    <handle>`, or terminate it.
- **Without a template:** `cocalc gpu launch --gpu <id> --max-runtime <minutes>`,
  plus `--ssh` to make the pod's SSH key in this project.
- **SSH:** after `connect`, `ssh <handle>` reaches the pod with its host key
  pinned. Only the project that launched the pod has its key.
- **Waiting:** don't poll the pod. Use `connect --wait`. For the deadline,
  set `cocalc sensor watch at --at <a few minutes before the deadline> --note "terminate cc-..."`
  right after the launch, and terminate the pod when it wakes you if the work
  isn't done.

## Your human's approval

As an agent you may launch only what your human approved, once: one pod,
exactly that launch, and only in this chat session (or this run of a
registered agent), until it ends.

- The first `launch` doesn't start anything. It fails with "needs your
  human's approval first: request <id>". **Then stop:** tell the human the
  request id, the GPU, the maximum runtime and the most it can cost (the dry
  run's `max_cost_usd`), and end your turn. Don't retry, and don't try a
  different launch to get around it: that makes a new request.
- The human sees the exact launch in a banner at the top of this project
  in CoCalc (or with `cocalc gpu agent requests`), and approves or
  declines it there, signing in again to approve. You can't approve
  anything yourself. If they decline, don't ask again unless they say so.
- Once approved, run **the identical command again**: same options, same
  `--operation` if you gave one. Any change is a different launch and needs
  a new approval. A second pod needs a second approval too.
- `pods`, `who`, `connect` and `terminate` show and reach only the pods this
  session launched (for a registered agent: any of its runs in this
  project). You can always terminate them.
- If the human revokes the approval, or presses the kill switch, CoCalc
  terminates the pod it launched; after a kill switch, every launch needs a
  new approval.
  When your session ends, no new launch is possible, but the pod runs to its
  maximum runtime: terminate it yourself when the work is done.

## A project's GPU funding

A collaborator can approve GPU use in a project, paid by **their own** RunPod
account, up to an amount and until a date (Settings → GPUs in the project,
or the banner at the top of the project). Then anyone who can run code in
the project can launch under it — including you, if the approval allows
agents. A launch's `paid_by` says whose money pays: the project's funding
approval (and its id) or a key owner's own RunPod key.

```bash
cocalc gpu funding                 # this project's approval: who pays, what's left, until when
cocalc gpu funding pods            # the GPUs it pays for (also ended ones, a day back)
cocalc gpu funding terminate cc-…  # end one of them
```

- **From the project's terminal (no signed-in account) give `--gpu`**:
  templates can't pick a GPU there, and `--dry-run`/`--max-cost` need a
  signed-in account. The approval's own limits (amount, $/h, pods, runtime,
  its end date) bound every launch; a pod must end before the approval does.
- **No approval and no key of your own**: `launch` exits with code 3 and the
  message says a request was recorded. **Stop and tell the human**: a
  collaborator with a RunPod key approves it in the project; then run the
  same launch again. Don't retry in a loop.
- **An agent whose project's approval doesn't allow agents** uses the
  per-launch approval below, on its human's own key.
- `--own-key` launches on the caller's own key even when the project is
  funded.
- Only the funder can lower (`cocalc gpu funding lower <approval-id>`) or end
  (`cocalc gpu funding end <approval-id>`) an approval; raising it needs a
  fresh sign-in in the browser. `cocalc gpu funding list` shows the approvals
  you gave.

## Facts

- **Secure Cloud is the default.** It gives the direct SSH endpoint that
  kernels need, usually within a minute.
- **Community Cloud is cheaper**, but some machines have no public IP, so
  the pod may never become reachable over SSH. Use it only for work that
  needs no kernel or SSH, or when the user asks for it.
- **Pods are terminate-only:** no stop or restart. Anything to keep must be
  copied off the pod before terminating it.
- **Costs come from the user's own RunPod account.** CoCalc adds no markup.
  Budgets in CoCalc bound what a launch may reserve, and RunPod's own account
  limits are the backstop.
- **Attribution:** `cocalc gpu who <handle-or-ip>` shows who launched a pod
  and what was done to it.
