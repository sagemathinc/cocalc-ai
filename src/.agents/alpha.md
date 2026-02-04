# Make an Alpha Release of CoCalc-AI

**Goal:** full functionality of the following products with no obvious bugs:

- cocalc-plus
- cocalc-launchpad

For alpha testing it will be deployed by:

- making cocalc-plus npm installable (so for now, requiring they install node+npm in some way first).   `npx @cocalc/plus` 
- running cocalc-launchpad with a reg token on a GCP VM with cloudflare,nebius,gcp,hyperstack,lambda all configured
  - `npx @cocalc/launchpad` 

## Blocker Todo List

- [x] plus: do not show membership in settings or any other none-lite things

- [ ] #n ow plus: enable app server proxy support (e.g., vscode, jupyter, etc.)

- [ ] jupyter kernel state isn't reported properly

- [ ] consider changing the persist sqlite path to the actual file path instead of a hash

- [ ] opening files not in HOME

- [ ] #bug chat scroll position jumping -- happens a lot when switching between two rooms

- [ ] plus: implement remote ssh, sync, and port forward integration

- [ ] plus: do not open account settings by default -- open file explorer

- [ ] launchpad: implement /scratch for workspaces (just another btrfs that is never snapshotted or backed up, and has the same size as the main filesystem for the project).

- [ ] launchpad: there are issues with rootfs overlayfs not unmounting properly still, probably due to the resource limiter thing.  this is very bad; e.g., it makes it so can't change the rootfs image.

- [ ] launchpad: when opening a workspace it always says: "Error
  request -- no subscribers matching 'fs.project-8e9626fc-1e50-419b-8be8-b353068fc5a5'" in the file explorer listing, because the host itself isn't ready yet or the project isn't itself provisioned.

- [ ] launchpad: right when starting a terminal on a new project on a cloud host, it hangs

- [ ] launchpad: improve how workspaces work:
  - [ ] install a nice .bashrc (instead of nothing)

- [ ] launchpad: curated image(s), with build automation

- [ ] launchpad: **rootfs images -** caching in R2 instead of pulling from upstream

- [ ] launchpad: update "cores" quota, no dedicated, no "member hosting".

- [ ] launchpad: make workspace UI aware of host status

- [ ] launchpad: one rustic repo for all projects a specific user creates in a region.

- [ ] launchpad: ssh to project via cloudflare tunnels and WARP, and/or just expose the ip of the server.

- [ ] codex: ui -- the headers in the thinking log get smooshed together still

- [ ] codex: memory leak when using codex chat for a long time

- [ ] codex: proxy so this actually works, or private directory with auth data that is copied into place on usage

- [ ] codex: codex-0.93 switched log format to use sqlite, so we may need to rewrite to use that.

- [x] #bug chat scroll position