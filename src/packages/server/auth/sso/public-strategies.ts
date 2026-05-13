/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Google is the only built-in public SSO provider. Everything else is defined
// through the organization-provider framework.

import { StrategyConf } from "@cocalc/server/auth/sso/types";
import { Strategy as GoogleStrategyOld } from "@passport-next/passport-google-oauth2";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

import getLogger from "@cocalc/backend/logger";

const L = getLogger("auth:sso:public-strategies");

// docs for getting these for your app
// https://developers.google.com/identity/protocols/oauth2/openid-connect#appsetup
// and https://console.developers.google.com/apis/credentials
//
// You must then put them in the database, via
//
// require 'c'; db()
// db.set_passport_settings(strategy:'google', conf:{clientID:'...',clientSecret:'...'}, cb:console.log)

// In 2023, we got emails about a deprecated login method, which is very puzzling.
// In any case, the "passport-next" variant is a unmaintaned fork of a fork of the original.
// Here, we allow to switch to the "main" module, mentioned on the website and still maintained.
// However, both are 4 years old and didn't get any updates – not sure, though.
// Setting this env-variable will allow testing the main variant, instead of the one we have.
// If you read this in the future, we already tested it. Remove the passport-next variant.
const useMainGoogleSSO = process.env.COCALC_AUTH_GOOGLE_SSO === "oauth20"; // by default, uses old passport-next module
const googleSSOtype = (
  useMainGoogleSSO
    ? "passport-google-oauth20"
    : "@passport-next/passport-google-oauth2"
) as any;
L.info(`Google SSO uses '${googleSSOtype}'`);

// Scope:
// Enabling "profile" below I think required that I explicitly go to Google Developer Console for the project,
// then select API&Auth, then API's, then Google+, then explicitly enable it.  Otherwise, stuff just mysteriously
// didn't work.  To figure out that this was the problem, I had to grep the source code of the passport-google-oauth
// library and put in print statements to see what the *REAL* errors were, since that
// library hid the errors (**WHY**!!?).
export const GoogleStrategyConf: StrategyConf = {
  name: "google",
  type: googleSSOtype,
  PassportStrategyConstructor: useMainGoogleSSO
    ? GoogleStrategy
    : GoogleStrategyOld,
  auth_opts: { scope: "openid email profile" },
  login_info: {
    id: (profile) => profile.id,
    first_name: (profile) => profile.name?.givenName ?? "Anonymous",
    last_name: (profile) => profile.name?.familyName ?? "User",
    emails: (profile) => profile.emails?.map((x) => x.value as string) ?? [],
  },
};
