# Project control

`index.ts` installs `getProject` as the database's project-control function.
`base.ts` implements `BaseProject`, including ownership checks, quota
resolution, project state, and start/stop coordination.

Project-host start and stop operations are delegated to
`../../project-host/control.ts`. Runtime quotas use membership and runtime
sponsorship, with storage sponsorship handled separately. Workspace-local
runtime handling is selected by `../../launchpad/project-runtime.ts`.

The former `SingleUser`, `MultiUser`, `KuCalc`, and direct `Kubernetes`
controller descriptions do not describe this directory's current
implementation. This module is not evidence of the deployment topology of a
particular live site.
