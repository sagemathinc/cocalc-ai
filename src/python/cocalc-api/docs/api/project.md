# Project execution

Create `cocalc_api.Project` with the target project ID and an account API key
that has `project:exec` and explicitly allows that project. The account must
be a collaborator, and the project service must be available. A project-scoped
CoCalc API key is not accepted by this HTTP bridge.

The method name for a project ping is `project.system.ping()`, not
`project.ping()`. Keep credentials in your local process environment; replace
the project ID with your intended target before making a request:

```py
import os
import cocalc_api

project = cocalc_api.Project(
    api_key=os.environ["COCALC_API_KEY"],
    project_id=os.environ["COCALC_PROJECT_ID"],
)
```

`project.system.exec(...)` executes a command in that project and can change
its files or processes. Check its returned `stdout`, `stderr`, and `exit_code`.
Its `timeout` argument describes command execution; do not assume it changes
all HTTP-client timeouts or proves that timed-out work has stopped.

`project.system.jupyter_execute()` remains in the Python client, but its
`system.jupyterExecute` RPC is absent from the current project API. For live
notebook editing and execution, use the
[notebook CLI guide](https://cocalc.ai/docs/cli/notebook-workflows).

<!-- prettier-ignore -->
::: cocalc_api.project.System.ping
    options:
      show_docstring_examples: false
      show_source: false

<!-- prettier-ignore -->
::: cocalc_api.project.System.exec
    options:
      show_docstring_examples: false
      show_source: false
