# Internal TestFlight beta

The first iOS beta is for internal testers only. Use the production variant,
`com.sagemath.cocalc.mobile`, so the build contains its JavaScript bundle and
does not depend on Metro. The development app has a separate bundle ID and is
not the TestFlight candidate.

## Candidate prepared on 2026-09-23

- Source: `feature/cocalc-mobile` at `0d0bda6dfa`.
- Bundle ID: `com.sagemath.cocalc.mobile`; version/build: `0.1.0 (1)`.
- Local archive: `/tmp/CoCalc-0.1.0-1-beta.xcarchive` (408 MB).
- Embedded `main.jsbundle` SHA-256:
  `92dd0e7c24a08d0b79f84568035794b36cf3355c0f8fd651b896edc2901e6385`.
- `xcodebuild archive` and `codesign --verify --deep --strict` passed. The
  packaged app includes camera, photo-library, and microphone permission
  strings, and the clean prebuild assigns the production Apple team.
- The preceding signed Release build passed the iPhone smoke test: cold launch
  without Metro, open chat, send a photo and PDF, and open the PDF link. This
  corrected archive adds the missing microphone permission and has not been
  installed or distributed.

The internal TestFlight export is **blocked at signing**. Xcode reported
`No Accounts`, no `iOS Distribution` certificate, and no provisioning profile
for this bundle ID. The machine has an Apple Development certificate, which
is sufficient for a paired-device build but not this distribution export.
No IPA was produced, and nothing was uploaded to Apple or offered to testers.

## Finish the candidate

1. Sign in to the appropriate Apple Developer Program account in **Xcode →
   Settings → Apple Accounts**. Confirm that Xcode can use team `BVF94G2MB4`
   and automatically manage distribution signing for
   `com.sagemath.cocalc.mobile`. Keep credentials in Xcode; do not add them to
   this repository.
2. Check App Store Connect for an existing iOS app record with that bundle ID.
   If none exists, create one before uploading. Suggested initial metadata for
   review: name **CoCalc**, primary language **English**, SKU
   `cocalc-mobile-ios`. Check that version/build `0.1.0 (1)` is unused; if it
   is already present, increment `ios.buildNumber` in `app.config.ts` and
   rebuild the archive.
3. Export the archive locally with method `app-store-connect`, destination
   `export`, team `BVF94G2MB4`, and
   `testFlightInternalTestingOnly=true`. Xcode's CLI documents these keys in
   `xcodebuild -help`. The checked-in options are in
   [`testflight-internal-export-options.plist`](testflight-internal-export-options.plist).
   Run this from `src/packages/mobile`:

   ```bash
   xcodebuild -exportArchive \
     -archivePath /tmp/CoCalc-0.1.0-1-beta.xcarchive \
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
> and attach a photo and a PDF. Check a long conversation, background and
> reopen the app, and report any lost draft, scroll jump, or payment-setting
> mismatch. Live voice is not part of this beta.

The local archive is a temporary build artifact; make a new one from the
committed source for a later candidate. This runbook does not claim App Store
review, an external beta, or a store release.

Apple references: [distribution from Xcode](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases),
[creating an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app),
and [adding an internal TestFlight group](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers).
