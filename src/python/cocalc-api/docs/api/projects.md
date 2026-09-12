# Project creation

`hub.projects.create_project()` requires an account key with `project:create`
and remains subject to the server's normal project-creation checks. Calling
it creates a project; it is not a dry run.

The client's project listing, start/stop, collaborator and copy wrappers are
not allowed by the current HTTP hub bridge. Use the
[CLI command reference](https://cocalc.ai/docs/cli/command-reference)
for those workflows and check each command's authentication requirements.

::: cocalc_api.hub.Projects.create_project
