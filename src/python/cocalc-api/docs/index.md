# CoCalc Python API client

The repository client requires Python 3.10 or newer. Install the published
package with:

```sh
pip install cocalc-api
```

Create an account API key in [CoCalc account settings](https://cocalc.ai/settings/keys).
Every new key needs explicit capabilities. Project execution also requires an
allowed project ID and an account that is a collaborator on that project.
Keep the key out of notebooks, source control, and shared outputs.

## Choose a supported call

The Python client sends `Hub` calls to `/api/conat/hub` and `Project` calls
to `/api/conat/project`. The server applies a method allowlist to the hub
bridge. Several legacy methods remain in the Python package but cannot be
used through that bridge, even with additional key capabilities.

| Python call                                            | Current server requirement                                                                                            |
| :----------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| `hub.system.ping()`                                    | A valid account API key. No extra capability check for this call; key creation still requires an explicit capability. |
| `hub.system.get_names(account_ids)`                    | `account:read`.                                                                                                       |
| `hub.projects.create_project(...)`                     | `project:create`, plus normal server project-creation checks. This creates a project.                                 |
| `project.system.ping()` and `project.system.exec(...)` | `project:exec`, the project in the key's allowlist, and collaborator access. The project service must be available.   |

User search, `hub.projects.get()`, start/stop, collaborator changes, copies,
`hub.db`, `hub.messages`, `hub.org`, and `hub.sync.history()` are not allowed
through the current HTTP hub bridge. Adding more capabilities does not make
these unlisted methods available. For project lifecycle, file and notebook
workflows, use the [CoCalc CLI guides](https://cocalc.ai/docs/cli/getting-started)
and the command's own help; authentication requirements depend on the command.

`project.system.jupyter_execute()` names a legacy RPC that is absent from the
current project API. Use the
[live notebook CLI workflow](https://cocalc.ai/docs/cli/notebook-workflows)
for notebook execution instead.

The pages below document this compatibility boundary and selected usable
methods. They describe current repository source; confirm the server and
installed client versions when using another deployment.
