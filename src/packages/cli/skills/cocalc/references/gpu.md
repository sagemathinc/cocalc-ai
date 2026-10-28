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
  maximum runtime. Launch only what the user asked for.
- **Always use the shortest sensible `--max-runtime`.** A pod is terminated
  at its deadline at the latest, and terminating it sooner is better.
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
cocalc gpu launch --template pytorch-kernel --dry-run   # the GPU, spec and max cost
cocalc gpu launch --template pytorch-kernel             # launch, SSH, kernel
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
- **Waiting:** don't poll the pod. Use `connect --wait`, or a sensor such as
  `cocalc sensor watch at --at <deadline> --note "terminate cc-..."` to come
  back before the deadline.

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
