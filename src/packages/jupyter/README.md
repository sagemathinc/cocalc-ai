# @cocalc/jupyter

## What this is

Shared Jupyter code used by CoCalc frontend and project backend components.

There is still a lot of Jupyter related code that hasn't been organized yet into this package. It's a refactor-in-progress situation.

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
