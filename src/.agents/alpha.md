# Make an Alpha Release of CoCalc-AI

**Goal:** full functionality of the following products with no obvious bugs:

- cocalc-plus
- cocalc-launchpad

For alpha testing it will be deployed by:

- making cocalc-plus npm installable (so for now, requiring they install node+npm in some way first).   `npx @cocalc/plus` 
- running cocalc-launchpad with a reg token on a GCP VM with cloudflare,nebius,gcp,hyperstack,lambda all configured
  - `npx @cocalc/launchpad` 

## Blocker Todo List

- [ ] when opening a workspace it often says: "Error
  request -- no subscribers matching 'fs.project-8e9626fc-1e50-419b-8be8-b353068fc5a5'" in the file explorer listing, because the host itself isn't ready yet or the project isn't itself provisioned.

- improve how workspaces actually work:
  - [ ] install a nice .bashrc (instead of nothing)
  - [ ] default suggested image(s), with build automation

- [ ] caching of rootfs images in R2 instead of pulling from upstream

- [ ] #bug chat scroll position

- 