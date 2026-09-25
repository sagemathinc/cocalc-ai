# @cocalc/jupyter

## What this is

Shared Jupyter code used by CoCalc frontend and project backend components.

There is still a lot of Jupyter related code that hasn't been organized yet into this package. It's a refactor-in-progress situation.

## Notebook output limit

Each cell execution has a cumulative 1 MiB output budget by default. The notebook's
**Run > Output limit** menu offers 1, 4, 16, and 64 MiB. The setting is saved in
`metadata.cocalc.output_limit_bytes` and applies to subsequent executions, including
CLI execution. Each execution gets a fresh budget; there is no wall-clock timeout.

The project-side notebook controller counts stdout, stderr, rich output, display
updates, errors, and clear-output messages before output conversion, replay, or
collaborative persistence. It retains whole messages within the budget, replaces
the first over-budget message with one truncation notice, then discards further
output. Clearing output does not reset the budget or remove that notice. Streams
count UTF-8 text bytes plus fixed per-message overhead; other output counts JSON
content and metadata. Binary buffers count toward either budget.

The computation keeps running, and input prompts, completion, interrupt, and
halt-on-error behavior remain available. For long-running jobs, increase the limit
before execution or write large results to a file. This is not an IOPub frame-size
or kernel-memory limit, does not cover widget/comm traffic, and does not repair
existing oversized notebooks or edit history. Stateless kernel APIs are unchanged.

## Directories

Large notebook outputs use a project-scoped AKV store opened by `redux/actions.ts`; there is no `blobs` subdirectory in this package. `execute` manages code execution. `ipynb` is for handling ipynb files, and `kernel` handles kernel enumeration and spawning. `nbgrader` contains CoCalc's grading tool for Jupyter notebooks. `redux` houses actions and stores for Jupyter's notebook doc compatibility. `stateless-api` implements a stateless code-evaluating API, and `util` includes miscellaneous Jupyter-related functionalities.

- [redux/actions.ts](./redux/actions.ts): opens the notebook AKV output store. [ipynb/blob-attachments.ts](./ipynb/blob-attachments.ts) separately handles embedding and externalizing image attachments through caller-supplied blob operations.
- [execute](./execute): handles execution of code
- [ipynb](./ipynb): handles importing and exporting to the ipynb format. CoCalc uses its own internal jsonlines format.
- [kernel](./kernel): enumerating and spawning kernels
- [nbgrader](./nbgrader): our implementation of nbgrader, especially the backend support
- [redux](./redux): Redux Actions and Store for jupyter, so we can work with the jupyter notebook doc
- [stateless\-api](./stateless-api): implements stateless api for evaluating code, which is used e.g., for the share server and in markdown.
- [types](./types): typescript declarations.
- [util](./util): little jupyter related things
