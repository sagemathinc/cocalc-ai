# Internal TestFlight beta

The first iOS beta is for internal testers only. Use the production variant,
`com.sagemath.cocalc.mobile`, so the build contains its JavaScript bundle and
does not depend on Metro. The development app has a separate bundle ID and is
not the TestFlight candidate.

## Current candidate built on 2026-09-24

- Source: `feature/cocalc-mobile` at
  `58cce520b4fc0a11e01f2cff4122bffc8f194e48`, including the browser and
  iPhone dictation fixes. The maintainer confirmed live voice and dictation
  work in both clients before this archive was made.
- Production iOS archive:
  `/tmp/CoCalc-voice-20260924-dictation.xcarchive`.
- Bundle ID: `com.sagemath.cocalc.mobile`; version/build: `0.1.0 (1)`.
- Embedded `main.jsbundle` SHA-256:
  `837c00ac857debd93bb10799e88ce34a40b6be04618b419485b90507823ac19d`.
- `xcodebuild archive` and `codesign --verify --deep --strict` passed. The
  native bundle and embedded Expo configuration both identify the production
  app. This exact archive has not yet been installed or tested on an iPhone.
- Internal TestFlight export was attempted with the checked-in options and
  `-allowProvisioningUpdates`. It failed with `No Accounts`, no
  `iOS Distribution` certificate, and no provisioning profile for this bundle
  ID. Xcode's Apple Accounts screen does show William STEIN's Developer Team
  with admin access, so the CLI's `No Accounts` message does not establish that
  the GUI account is signed out. No IPA was produced or uploaded. Try Xcode's
  Organizer distribution flow with automatic signing before retrying the CLI.

## Earlier funded live voice candidate

- Source: `feature/cocalc-mobile` at
  `c6d9c9a70a66be6241d56b7b2384311604991a20`, with site-funded voice and
  browser live voice.
- Production iOS archive:
  `/tmp/CoCalc-voice-20260924-production.xcarchive`.
- Bundle ID: `com.sagemath.cocalc.mobile`; version/build: `0.1.0 (1)`.
- Embedded `main.jsbundle` SHA-256:
  `a65c6477f82af40244c16b4ac22567eafdcd8ce4a17434017da84b1077f4a508`.
- `xcodebuild archive` and `codesign --verify --deep --strict` passed. The
  native bundle and embedded Expo configuration both identify the production
  app. The build was installed on the paired iPhone, and the maintainer
  confirmed it opens. Physical-device provider audio and a matching browser
  call still need qualification.
- Staging has matching hub and static bundles. Voice is currently enabled
  there only for administrator testing through `COCALC_LIVE_VOICE_DEV=1`;
  general paid-account access remains off pending real-call verification.

The archive was made with `COCALC_MOBILE_VARIANT=production`. Always set that
variable when archiving; otherwise the embedded Expo configuration can say
"CoCalc Dev" even when the native bundle ID is production. Inspect
`EXConstants.bundle/app.config` before installing or exporting an archive.

## Previous candidate rebuilt on 2026-09-23

This archive predates funded live voice. It is superseded for the planned
internal beta; build a fresh archive from the committed voice implementation
after staging provider and physical-device qualification.

- Source: `feature/cocalc-mobile` at `655ac91c4b`, including the merge of
  `origin/main` at `de9a62c731` and the mobile payment-settings fix.
- Bundle ID: `com.sagemath.cocalc.mobile`; version/build: `0.1.0 (1)`.
- Local archive: `/tmp/CoCalc-0.1.0-1-merged-beta.xcarchive`.
- Embedded `main.jsbundle` SHA-256:
  `c68c01b2098f136262ea9b8a99dfdf01141401282bdaf96dde303aa684e89700`.
- `xcodebuild archive` and `codesign --verify --deep --strict` passed. The
  packaged app includes camera, photo-library, and microphone permission
  strings, and the clean prebuild assigns the production Apple team.
- The preceding signed Release build passed the iPhone smoke test: cold launch
  without Metro, open chat, send a photo and PDF, and open the PDF link. The
  maintainer also confirmed agent creation and subscription settings against
  the updated staging hub and project host. This new archive was installed on
  the paired iPhone; a CLI launch attempt was refused because the phone was
  locked, so a fresh open-and-send smoke test remains pending. It has not been
  distributed.

The internal TestFlight export is **blocked at signing**. Xcode reported
`No Accounts`, no `iOS Distribution` certificate, and no provisioning profile
for this bundle ID when the rebuilt archive was exported. The machine has an
Apple Development certificate, which is sufficient for a paired-device build
but not this distribution export.
No IPA was produced, and nothing was uploaded to Apple or offered to testers.

## Finish the candidate

1. Open the current archive in Xcode with
   `/usr/bin/open -a Xcode /tmp/CoCalc-voice-20260924-dictation.xcarchive`. In
   **Window → Organizer → Archives**, select the CoCalc archive and click
   **Distribute App**. In Xcode 26.6, choose **Custom → Distribute**, then
   **App Store Connect → Export**. The top-level **TestFlight Internal Only**
   shortcut uploads directly, so do not choose it for a local IPA review.
   Enable **TestFlight internal testing only** in the custom options and choose
   **Automatically manage signing** for team `BVF94G2MB4`. Follow any Xcode
   account prompts. If Xcode cannot create distribution signing, use **Xcode →
   Settings → Apple Accounts → Manage Certificates… → + → Apple Distribution**
   for that team, then retry the GUI export. Keep credentials in Xcode; do not
   add them to this repository.
2. Check App Store Connect for an existing iOS app record with that bundle ID.
   If none exists, create one before uploading. Suggested initial metadata for
   review: name **CoCalc**, primary language **English**, SKU
   `cocalc-mobile-ios`. Check that version/build `0.1.0 (1)` is unused; if it
   is already present, increment `ios.buildNumber` in `app.config.ts` and
   rebuild the archive.
3. If the GUI did not export an IPA, retry command-line export once Xcode has
   created the signing assets. Use method `app-store-connect`, destination
   `export`, team `BVF94G2MB4`, and
   `testFlightInternalTestingOnly=true`. Xcode's CLI documents these keys in
   `xcodebuild -help`. The checked-in options are in
   [`testflight-internal-export-options.plist`](testflight-internal-export-options.plist).
   Run this from `src/packages/mobile`:

   ```bash
   xcodebuild -exportArchive \
     -archivePath /tmp/CoCalc-voice-20260924-dictation.xcarchive \
     -exportOptionsPlist testflight-internal-export-options.plist \
     -exportPath /tmp/CoCalc-TestFlight-internal \
     -allowProvisioningUpdates
   ```

4. Inspect the exported IPA's bundle ID, version, signing, and embedded
   bundle. Upload only after reviewing that concrete artifact. Create a small
   internal tester group and assign this build manually after processing.
   This internal-only build must not be added to external testing.

Suggested **What to Test** text:

> Sign in to your CoCalc site, open and create agents, read and send messages,
> and attach a photo and a PDF. Start a live voice call in an agent thread,
> speak a task, confirm it appears in chat, and end the call while the agent
> continues. Check a long conversation, background and reopen the app, and
> report any lost draft, scroll jump, audio-routing, or payment-setting mismatch.

Qualify the matching **Live voice** control in the web agent workspace against
the same staging home-bay service before widening the beta.

The local archive is a temporary build artifact; make a new one from the
committed source for a later candidate. This runbook does not claim App Store
review, an external beta, or a store release.

Apple references: [distribution from Xcode](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases),
[creating an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app),
and [adding an internal TestFlight group](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers).
