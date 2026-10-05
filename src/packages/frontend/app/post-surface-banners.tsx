/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { I18NBanner, useShowI18NBanner } from "./i18n-banner";
import { LegacyMigrationCtaBanner } from "./legacy-migration-cta-banner";
import { MembershipTrialBanner } from "./membership-trial-banner";
import {
  SiteLicenseClaimBanner,
  useSiteLicenseClaimBannerState,
} from "./site-license-claim-banner";
import { TeamLicenseWarningBanner } from "./team-license-warning-banner";
import { VerifyEmail } from "./verify-email-banner";
import { CookieWarning, LocalStorageWarning } from "./warnings";

export function PostSurfaceBanners({
  cookieWarning,
  fullscreen,
  localStorageWarning,
}: {
  cookieWarning: boolean;
  fullscreen: boolean;
  localStorageWarning: boolean;
}) {
  const showI18n = useShowI18NBanner();
  const siteLicenseBanner = useSiteLicenseClaimBannerState({
    enabled: !fullscreen,
  });
  return (
    <>
      {cookieWarning ? <CookieWarning /> : undefined}
      {localStorageWarning ? <LocalStorageWarning /> : undefined}
      {showI18n ? <I18NBanner /> : undefined}
      <TeamLicenseWarningBanner />
      <VerifyEmail />
      {!fullscreen ? (
        <SiteLicenseClaimBanner state={siteLicenseBanner} />
      ) : undefined}
      {!fullscreen &&
      !siteLicenseBanner.loading &&
      !siteLicenseBanner.suppressTrial ? (
        <MembershipTrialBanner />
      ) : undefined}
      {!fullscreen ? <LegacyMigrationCtaBanner /> : undefined}
    </>
  );
}
