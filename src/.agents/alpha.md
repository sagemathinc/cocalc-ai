# Make an Alpha Release of CoCalc-AI

**Goal:** full functionality of the following products with no obvious bugs:

- cocalc-plus
- cocalc-launchpad

For alpha testing it will be deployed by:

- making cocalc-plus npm installable (so for now, requiring they install node+npm in some way first).   `npx @cocalc/plus` 
- running cocalc-launchpad with a reg token on a GCP VM with cloudflare,nebius,gcp,hyperstack,lambda all configured
  - `npx @cocalc/launchpad` 

## Blocker Todo List

- [ ] plus: drag-n-drop to upload doesn't work; this matters because we do run this on REMOTE machines.

- [ ] opening files not in \$HOME
  - [ ] #bug in cocalc-plus I did this: `ln -s / .root; open .root` and ended up with an unclosable broken tab.
  - [ ] just fully go through and support PATH's that start with /, but have them give an error when access through safe fs sandbox.  Make paths starting with / map to the overlayfs mountpoint if it exists; if it doesn't, it's an error saying you must start the workspace.  The location of the overlayfs will be input to creating the sandbox.  Finally if an absolute path is in the actual home directory of the user, that's an error, to keep things canonical.
  - [ ] for the persist server, we have directories -- jupyter/, patchflow/, etc., that have a relative-to-home path under them.  For absolute paths we have to similarly name things, so how about we just do:
    - jupyter/root and jupyter/home
    - patchflow/root and patchflow/home
  - Alternative to all of this... just make ALL paths absolute.  Is it possible?

- [ ] plus: implement remote ssh, sync, and port forward integration

- [ ] plus: fullscreen button

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

- [ ] codex: ui -- the markdown headers in the thinking log get smooshed together still

- [ ] codex: memory leak when using codex chat for a long time

- [ ] codex: proxy so this actually works, or private directory with auth data that is copied into place on usage

- [ ] codex: codex-0.93 switched log format to use sqlite, so we may need to rewrite to use that.

- [x]  change the persist sqlite path to the actual file path instead of a hash

- [x] jupyter kernel state isn't reported properly

- [x] plus: do not show membership in settings or any other none-lite things

- [x] plus: enable app server proxy support (e.g., vscode, jupyter, etc.)

- [x] #bug chat scroll position