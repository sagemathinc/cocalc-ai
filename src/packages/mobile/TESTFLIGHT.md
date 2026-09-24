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
- The command-line export failed with `No Accounts`, but Xcode's Organizer
  successfully created cloud-managed Apple Distribution signing and an iOS
  Team Store provisioning profile for this bundle ID. A local internal-only
  App Store Connect export was made with automatic signing, symbols included,
  and version/build management disabled:
  `/tmp/CoCalc-TestFlight-internal-dictation/CoCalc.ipa`.
- Exported IPA SHA-256:
  `291864fcaf2c193035b92ab12c098e365501eb72fe35bbd51dcd3d090d3f9937`.
  Its bundle ID and `0.1.0 (1)` version match the archive, the embedded
  `main.jsbundle` hash matches above, and `codesign --verify --deep --strict`
  passes on the extracted app. The export options record
  `testFlightInternalTestingOnly=true`; the store profile includes
  `beta-reports-active=true` and `get-task-allow=false`.
- Xcode offered to create an App Store Connect app record during export. That
  step was skipped so the IPA could be inspected first. Nothing has been
  uploaded or assigned to testers.

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

## Finish the internal beta

1. The local IPA export and inspection are complete. To repeat the GUI export,
   open the current archive in Xcode with
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
2. Create an App Store Connect iOS app record for that bundle ID before
   uploading. Suggested initial metadata for review: name **CoCalc**, primary
   language **English**, SKU
   `cocalc-mobile-ios`. Check that version/build `0.1.0 (1)` is unused; if it
   is already present, increment `ios.buildNumber` in `app.config.ts` and
   rebuild the archive.
3. The existing IPA is ready for a reviewed internal-only upload. A future
   command-line export may still need a local distribution identity because
   Xcode used a cloud-managed certificate for this GUI export. If retrying the
   CLI, use method `app-store-connect`, destination
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

4. The IPA's bundle ID, version, signing, and embedded bundle were inspected.
   After upload and processing, create a small internal tester group and assign
   this build manually.
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
