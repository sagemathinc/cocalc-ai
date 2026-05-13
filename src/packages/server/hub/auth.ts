/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Authentication routes.
//
// SSO is intentionally limited to admin-configured Google OIDC and SAML
// providers. Legacy DB-only Passport strategy loading is not supported.

import Cookies from "cookies";
import dot from "dot-object";
import type { NextFunction, Request, Response } from "express";
import * as express from "express";
import express_session from "express-session";
import * as _ from "lodash";
import ms from "ms";
import { SAML } from "@node-saml/passport-saml";
import passport from "passport";
import { join as path_join } from "path";
import safeJsonStringify from "safe-json-stringify";
import { v4 as uuidv4, v4 } from "uuid";
import passwordHash, {
  verifyPassword,
} from "@cocalc/backend/auth/password-hash";
import base_path from "@cocalc/backend/base-path";
import { getLogger } from "@cocalc/backend/logger";
import type { PostgreSQL } from "@cocalc/database/postgres/types";
import { PassportLogin } from "@cocalc/server/auth/sso/passport-login";
import {
  InitPassport,
  LoginInfo,
  PassportManagerOpts,
} from "@cocalc/server/auth/sso/types";
import { callback2 as cb2 } from "@cocalc/util/async-utils";
import * as misc from "@cocalc/util/misc";
import { DNS } from "@cocalc/util/theme";
import { PassportStrategyFrontend } from "@cocalc/util/types/passport-types";
import {
  email_verification_problem,
  email_verified_successfully,
  welcome_email,
} from "./email";
// NOTE: we do not install saml2js, outdated package, this is just for future reference and debugging
//import Saml2js from "saml2js";
import { WinstonLogger } from "@cocalc/backend/logger";
import {
  getOauthCache,
  getPassportCache,
} from "@cocalc/database/postgres/auth/passport-store";
import { getServerSettings } from "@cocalc/database/settings";
import {
  GOOGLE_SSO_STRATEGY,
  getGoogleSsoSettingsState,
} from "@cocalc/database/settings/google-sso";
import {
  applyDomainPoliciesToPassports,
  getEnabledSsoDomainPolicies,
} from "@cocalc/database/settings/sso-policies";
import {
  getEnabledSamlSsoProviders,
  isValidSsoProviderID,
  ssoProviderToPassportStrategy,
} from "@cocalc/database/settings/sso-providers";
import {
  PassportLoginOpts,
  PassportStrategyDB,
  PassportTypes,
} from "@cocalc/database/settings/auth-sso-types";
import { signInUsingImpersonateToken } from "@cocalc/server/auth/impersonate";
import {
  BLACKLISTED_STRATEGIES,
  DEFAULT_LOGIN_INFO,
  SSO_API_KEY_COOKIE_NAME,
} from "@cocalc/server/auth/sso/consts";
import {
  exchangeGoogleOidcCode,
  googleOidcAuthorizationUrl,
  googleProfileFromClaims,
  verifyGoogleIdToken,
} from "@cocalc/server/auth/sso/google-oidc";
import {
  directSamlConfig,
  passportProfileFromSamlProfile,
} from "@cocalc/server/auth/sso/direct-saml";
import {
  logSsoAuditEvent,
  sanitizeSsoAuditReason,
  ssoAuditProviderType,
} from "@cocalc/server/auth/sso/audit";
import siteUrl from "@cocalc/server/hub/site-url";

const logger = getLogger("server:hub:auth");

const SUPPORTED_PUBLIC_SSO = ["google"] as const;

// root for authentication related endpoints -- will be prefixed with the base_path
const AUTH_BASE = "/auth";

const { defaults, required } = misc;

// singleton
let pp_manager: PassportManager | null = null;

export function get_passport_manager() {
  return pp_manager;
}

export async function init_passport(opts: InitPassport) {
  opts = defaults(opts, {
    router: required,
    database: required,
    host: required,
    cb: required,
  });

  try {
    if (pp_manager == null) {
      pp_manager = new PassportManager(opts);
      await pp_manager.init();
    }
    opts.cb();
  } catch (err) {
    opts.cb(err);
  }
}

interface HandleReturnOpts {
  Linit: WinstonLogger;
  name: string;
  type: PassportTypes;
  update_on_login: boolean;
  cookie_ttl_s: number | undefined;
  login_info: LoginInfo;
}

interface GoogleOidcState {
  nonce: string;
}

export class PassportManager {
  // express js, passed in from hub's main file
  private readonly router: express.Router;
  // the database, for various server queries
  private readonly database: PostgreSQL;
  // set in the hub, passed in -- not used by "site_conf", though
  private readonly host: string; // e.g. 127.0.0.1
  // configured strategies
  private passports: { [k: string]: PassportStrategyDB } | undefined =
    undefined;
  private readonly directSamlStrategies = new Set<string>();
  // prefix for those endpoints, where SSO services return back
  private auth_url: string | undefined = undefined;
  private site_url = `https://${DNS}${base_path}`; // updated during init

  constructor(opts: PassportManagerOpts) {
    const { router, database, host } = opts;
    this.handle_get_api_key.bind(this);
    this.router = router;
    this.database = database;
    this.host = host;
  }

  private async initAuthStrategies(): Promise<{
    [k: string]: PassportStrategyDB;
  }> {
    if (this.passports != null) {
      logger.debug("already initialized -- just returning what we have");
      return this.passports;
    }
    try {
      // email is always included, if even email singup is disabled
      // use "register tokens" to restrict this method
      this.passports = {
        email: {
          strategy: "email",
          conf: { type: "email" },
          info: { public: true },
        },
      };
      const googleSso = await getGoogleSsoSettingsState();
      if (googleSso.strategy != null) {
        this.passports[GOOGLE_SSO_STRATEGY] = googleSso.strategy;
      }
      const directSamlProviders = await getEnabledSamlSsoProviders();
      for (const provider of directSamlProviders) {
        const name = provider.provider_id;
        if (!isValidSsoProviderID(name)) {
          logger.warn(`Ignoring SSO provider '${name}' with unsafe id.`);
          continue;
        }
        if (BLACKLISTED_STRATEGIES.includes(name as any)) {
          throw new Error(
            `It is not allowed to name a strategy endpoint "${name}", because it is used by the next.js /auth/* endpoint. See next/pages/auth/ROUTING.md for more information.`,
          );
        }
        if (this.passports[name] != null) {
          throw new Error(
            `SSO provider '${name}' conflicts with another configured authentication strategy.`,
          );
        }
        const strategy = ssoProviderToPassportStrategy(provider);
        if (strategy == null) continue;
        this.passports[name] = strategy;
        this.directSamlStrategies.add(name);
      }
      applyDomainPoliciesToPassports(
        this.passports,
        await getEnabledSsoDomainPolicies(),
      );
      return this.passports;
    } catch (err) {
      logger.debug(`error getting passport settings -- ${err}`);
      throw err;
    }
    return {};
  }

  // Define handler for api key cookie setting.
  private handle_get_api_key(req: Request, res: Response, next: NextFunction) {
    if (req.query.get_api_key) {
      logger.debug("handle_get_api_key");
      const cookies = new Cookies(req, res);
      // maxAge: User gets up to 60 minutes to go through the SSO process...
      cookies.set(SSO_API_KEY_COOKIE_NAME, req.query.get_api_key, {
        maxAge: 30 * 60 * 1000,
      });
    }
    next();
  }

  // this is for pure backwards compatibility. at some point remove this!
  // it only returns a string[] array of the legacy authentication strategies
  private strategies_v1(res): void {
    const data: string[] = [];
    const known = ["email", ...SUPPORTED_PUBLIC_SSO];
    for (const name in this.passports) {
      if (name === "site_conf") continue;
      if (known.indexOf(name) >= 0) {
        data.push(name);
      }
    }
    res.json(data);
  }

  public get_strategies_v2(): PassportStrategyFrontend[] {
    const data: PassportStrategyFrontend[] = [];
    // we cast the result of _.pick to get more type saftey
    const keys = [
      "display",
      "type",
      "icon",
      "public",
      "exclusive_domains",
      "do_not_hide",
    ] as const;
    for (const name in this.passports) {
      if (name === "site_conf") continue;
      // this is sent to the web client → do not include any secret info!
      const info: PassportStrategyFrontend = {
        name,
        ...(_.pick(this.passports[name].info, keys) as {
          [key in (typeof keys)[number]]: any;
        }),
      };
      data.push(info);
    }
    return data;
  }

  // version 2 tells the web client a little bit more.
  // the additional info is used to render customizeable SSO icons.
  private strategies_v2(res): void {
    res.json(this.get_strategies_v2());
  }

  async init(): Promise<void> {
    // Initialize authentication plugins using Passport
    logger.debug("init");

    // initialize use of middleware
    // @ts-ignore
    this.router.use(
      express_session({
        secret: v4(), // secret is totally random and per-hub session
        resave: false,
        saveUninitialized: false,
      }),
    );
    // @ts-ignore
    this.router.use(passport.initialize());
    this.router.use(passport.session());

    // Define user serialization
    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((user: Express.User, done) => done(null, user));

    // this.router endpoints setup
    this.init_strategies_endpoint();
    this.initImpersonate();
    this.init_email_verification();
    this.init_password_reset_token();

    // prerequisite for setting up any SSO endpoints
    await this.initAuthStrategies();
    this.check_exclusive_domains_unique();

    this.site_url = await siteUrl();
    this.auth_url = await siteUrl(AUTH_BASE);
    logger.debug(`auth_url='${this.auth_url}'`);

    await Promise.all([this.initGoogleOidc(), this.initDirectSamlStrategies()]);
  }

  // check if exclusive domains are unique
  private check_exclusive_domains_unique() {
    const ret: { [k: string]: string } = {};
    for (const k in this.passports) {
      const v = this.passports[k];
      for (const domain of v.info?.exclusive_domains ?? []) {
        if (ret[domain] != null) {
          throw new Error(
            `exclusive domain '${domain}' defined by ${ret[domain]} and ${k}: they must be unique`,
          );
        }
        ret[domain] = k;
      }
    }
  }

  private init_strategies_endpoint(): void {
    // Return the configured and supported authentication strategies.
    this.router.get(`${AUTH_BASE}/strategies`, (req, res) => {
      if (req.query.v === "2") {
        this.strategies_v2(res);
      } else {
        this.strategies_v1(res);
      }
    });
  }

  private async init_email_verification(): Promise<void> {
    // email verification
    this.router.get(`${AUTH_BASE}/verify`, async (req, res) => {
      const url = await siteUrl("app");
      res.header("Content-Type", "text/html");
      res.header("Cache-Control", "no-cache, no-store");
      if (
        !(req.query.token && req.query.email) ||
        typeof req.query.email !== "string" ||
        typeof req.query.token !== "string"
      ) {
        res.send(
          "ERROR: I need the email address and the corresponding token data",
        );
        return;
      }

      const email = decodeURIComponent(req.query.email);
      // .toLowerCase() on purpose: some crazy MTAs transform everything to uppercase!
      const token = req.query.token.toLowerCase();
      try {
        await cb2(this.database.verify_email_check_token, {
          email_address: email,
          token,
        });
        res.send(email_verified_successfully(url));
      } catch (err) {
        res.send(email_verification_problem(url, err));
      }
    });
  }

  private init_password_reset_token(): void {
    // reset password: user email link contains a token, which we store in a session cookie.
    // this prevents leaking that token to 3rd parties as a referrer
    // endpoint has to match with @cocalc/hub/password
    this.router.get(`${AUTH_BASE}/password_reset`, async (req, res) => {
      if (typeof req.query.token !== "string") {
        res.send("ERROR: reset token must be set");
      } else {
        const token = req.query.token.toLowerCase();
        const cookies = new Cookies(req, res);
        // to match @cocalc/frontend/client/password-reset
        const name = encodeURIComponent(`${base_path}PWRESET`);
        const secure = req.protocol === "https";
        let sameSite;
        if (secure) {
          const { samesite_remember_me } = await getServerSettings();
          sameSite = samesite_remember_me;
        } else {
          sameSite = undefined;
        }

        cookies.set(name, token, {
          maxAge: ms("5 minutes"),
          secure,
          overwrite: true,
          httpOnly: false,
          sameSite,
        });
        res.redirect("../app");
      }
    });
  }

  private getHandleReturn(opts: HandleReturnOpts) {
    const { Linit, name, type, update_on_login, cookie_ttl_s, login_info } =
      opts;
    return async (req, res: express.Response) => {
      if (req.user == null) {
        throw Error("req.user == null -- that shouldn't happen");
      }
      const Lret = Linit.extend(`${name}/return`).debug;
      // usually, we pick the "profile", but in some cases like SAML this is in "attributes".
      // finally, as a fallback, we just take the ".user"
      // technically, req.user should never be undefined, though.
      // Example: 2023-10-11 for SAML v4 this is
      // req.user = {"issuer":"http://adfs.cornellcollege.edu/adfs/services/trust",
      // "inResponseTo":"_341e8226b4....","sessionIndex":"_...$...",
      // "nameID":"1234567890","email":"....@cornellcollege.edu",
      // "first_name":"[name]","last_name":"[name]"
      // "attributes":{"email":"...@cornellcollege.edu","first_name":"[name]","last_name":"[name]"}}

      Lret(`req.user = ${safeJsonStringify(req.user)}`);

      const profile_raw =
        req.user.profile != null
          ? req.user.profile
          : req.user.attributes != null
            ? req.user.attributes
            : req.user;

      // Be defensive in case a provider returns a serialized profile.
      let profile: passport.Profile;
      try {
        profile = (typeof profile_raw === "string"
          ? JSON.parse(profile_raw)
          : profile_raw) as any as passport.Profile;
      } catch (err) {
        Lret(`error parsing profile: ${err} -- ${profile_raw}`);
        await this.logSsoReturnDenied({
          name,
          phase: "profile_parse",
          err,
          req,
        });
        const { help_email } = await cb2(
          this.database.get_server_settings_cached,
        );
        const err_msg = `Error trying to login using '${name}' -- if this problem persists please contact ${help_email} -- ${err}<br/><pre>${err.stack}</pre>`;
        Lret(`sending error "${err_msg}"`);
        res.send(err_msg);
        return;
      }

      if (type === "saml") {
        // the nameID is set via the conf.identifierFormat parameter – even if we set it to
        // persistent, we might still just get an email address, though
        Lret(`nameID format we actually got is ${req.user.nameIDFormat}`);
        profile.id = req.user.nameID;
      }

      Lret(`profile = ${safeJsonStringify(profile)}`);

      const login_opts: PassportLoginOpts = {
        passports: this.passports ?? {},
        database: this.database,
        host: this.host,
        id: profile.id, // ATTN: not all strategies have an ID → you have to derive the ID from the profile below via the "login_info" mapping (e.g. {id: "email"})
        strategyName: name,
        profile, // will just get saved in database
        update_on_login,
        cookie_ttl_s,
        req,
        res,
        site_url: this.site_url,
      };

      const dotInstance =
        typeof login_info._sep === "string" ? new dot(login_info._sep) : dot;

      for (const k in login_info) {
        if (k === "_sep") continue; // used above, not useful here
        const v = login_info[k];
        const param: string | string[] =
          typeof v == "function"
            ? // v is a LoginInfoDerivator<T>
              v(profile)
            : // v is a string for dot-object
              dotInstance.pick(v, profile);
        login_opts[k] = param;
      }

      const passportLogin = new PassportLogin(login_opts);
      try {
        await passportLogin.login();
      } catch (err) {
        let err_msg = "";
        // due to https://github.com/Microsoft/TypeScript/issues/13965 we have to check on name and can't use instanceof
        if (err.name === "PassportLoginError") {
          const signInUrl = path_join(base_path, "auth", "sign-in");
          err_msg = `Problem signing in using '${name}':<br/><strong>${
            err.message ?? `${err}`
          }</strong><br/><a href="${signInUrl}">Sign-in again</a>`;
        } else {
          const helpEmail = await passportLogin.getHelpEmail();
          err_msg = `Error trying to login using '${name}' -- if this problem persists please contact ${helpEmail} -- ${err}<br/><pre>${err.stack}</pre>`;
        }
        Lret(`sending error "${err_msg}"`);
        res.send(err_msg);
      }
    };
  }

  private async sendPassportLoginError({
    name,
    res,
    passportLogin,
    err,
    includeDetails = true,
  }: {
    name: string;
    res: express.Response;
    passportLogin?: PassportLogin;
    err: any;
    includeDetails?: boolean;
  }): Promise<void> {
    let err_msg = "";
    if (err.name === "PassportLoginError") {
      const signInUrl = path_join(base_path, "auth", "sign-in");
      err_msg = `Problem signing in using '${name}':<br/><strong>${
        err.message ?? `${err}`
      }</strong><br/><a href="${signInUrl}">Sign-in again</a>`;
    } else {
      const helpEmail =
        passportLogin != null
          ? await passportLogin.getHelpEmail()
          : (await cb2(this.database.get_server_settings_cached)).help_email;
      err_msg = `Error trying to login using '${name}' -- if this problem persists please contact ${helpEmail}`;
      if (includeDetails) {
        err_msg += ` -- ${err}`;
      }
    }
    logger.debug(`sending error "${err_msg}"`);
    res.send(err_msg);
  }

  private async logSsoReturnDenied({
    name,
    phase,
    err,
    req,
  }: {
    name: string;
    phase: string;
    err: unknown;
    req: express.Request;
  }): Promise<void> {
    await logSsoAuditEvent({
      database: this.database,
      event: "sso_sign_in_denied",
      value: {
        strategy: name,
        provider_type: ssoAuditProviderType(this.passports?.[name]),
        phase,
        reason: sanitizeSsoAuditReason(err),
        ip_address: req.ip,
      },
    });
  }

  private googleOidcRedirectURI(): string {
    if (this.auth_url == null) {
      throw new Error("auth_url must be initialized before Google OIDC");
    }
    return `${this.auth_url}/google/return`;
  }

  private async initGoogleOidc(): Promise<void> {
    if (this.passports == null) throw Error("strategies not initalized!");
    const strategy = this.passports[GOOGLE_SSO_STRATEGY];
    if (strategy == null) {
      logger.debug("Google OIDC is not configured; skipping /auth/google");
      return;
    }
    const clientID = strategy.conf.clientID;
    const clientSecret = strategy.conf.clientSecret;
    if (!clientID || !clientSecret) {
      logger.warn("Google OIDC is enabled but missing client ID or secret");
      return;
    }

    const stateCache = getOauthCache(GOOGLE_SSO_STRATEGY);
    this.router.get(
      `${AUTH_BASE}/google`,
      this.handle_get_api_key,
      async (_req, res) => {
        try {
          const state = uuidv4();
          const nonce = uuidv4();
          const savedState: GoogleOidcState = { nonce };
          await stateCache.saveAsync(state, JSON.stringify(savedState));
          res.redirect(
            googleOidcAuthorizationUrl({
              clientID,
              redirectURI: this.googleOidcRedirectURI(),
              state,
              nonce,
            }),
          );
        } catch (err) {
          logger.warn(`Google OIDC sign-in start failed: ${err}`);
          await this.sendPassportLoginError({
            name: GOOGLE_SSO_STRATEGY,
            res,
            err,
            includeDetails: false,
          });
        }
      },
    );

    this.router.get(`${AUTH_BASE}/google/return`, async (req, res) => {
      let passportLogin: PassportLogin | undefined;
      try {
        if (typeof req.query.error === "string") {
          throw new Error(
            `Google returned an authentication error: ${req.query.error}`,
          );
        }
        if (typeof req.query.code !== "string") {
          throw new Error("Google OIDC return is missing the code parameter.");
        }
        if (typeof req.query.state !== "string") {
          throw new Error("Google OIDC return is missing the state parameter.");
        }
        const savedStateRaw = await stateCache.getAsync(req.query.state);
        await stateCache.removeAsync(req.query.state);
        if (savedStateRaw == null) {
          throw new Error("Google OIDC state is invalid or expired.");
        }
        const savedState = JSON.parse(savedStateRaw) as GoogleOidcState;
        if (!savedState.nonce) {
          throw new Error("Google OIDC state did not include a nonce.");
        }

        const tokens = await exchangeGoogleOidcCode({
          code: req.query.code,
          clientID,
          clientSecret,
          redirectURI: this.googleOidcRedirectURI(),
        });
        const claims = await verifyGoogleIdToken({
          idToken: tokens.id_token,
          clientID,
          nonce: savedState.nonce,
        });
        const profile = googleProfileFromClaims(claims);
        const emails = profile.emails?.map((email) => email.value) ?? [];
        passportLogin = new PassportLogin({
          passports: this.passports ?? {},
          database: this.database,
          host: this.host,
          id: profile.id,
          strategyName: GOOGLE_SSO_STRATEGY,
          profile,
          first_name: profile.name?.givenName ?? "Anonymous",
          last_name: profile.name?.familyName ?? "User",
          emails,
          update_on_login: strategy.info?.update_on_login ?? false,
          cookie_ttl_s: strategy.info?.cookie_ttl_s,
          req,
          res,
          site_url: this.site_url,
        });
        await passportLogin.login();
      } catch (err) {
        if (err.name !== "PassportLoginError") {
          logger.warn(`Google OIDC sign-in failed: ${err}`);
          await this.logSsoReturnDenied({
            name: GOOGLE_SSO_STRATEGY,
            phase: "google_oidc_return",
            err,
            req,
          });
        }
        await this.sendPassportLoginError({
          name: GOOGLE_SSO_STRATEGY,
          res,
          passportLogin,
          err,
          includeDetails: false,
        });
      }
    });
  }

  private getDirectSaml(name: string): SAML {
    if (this.auth_url == null) {
      throw new Error("auth_url must be initialized before direct SAML");
    }
    const strategy = this.passports?.[name];
    if (strategy == null) {
      throw new Error(`direct SAML strategy '${name}' is not configured`);
    }
    return new SAML(
      directSamlConfig({
        name,
        authUrl: this.auth_url,
        config: strategy.conf,
        cacheProvider: getPassportCache(name, ms("8 hours")),
      }),
    );
  }

  private async initDirectSamlStrategies(): Promise<void> {
    if (this.passports == null) throw Error("strategies not initalized!");
    for (const name of this.directSamlStrategies) {
      const strategy = this.passports[name];
      if (strategy == null) continue;
      // Validate config at startup instead of first user click.
      this.getDirectSaml(name);

      const strategyUrl = `${AUTH_BASE}/${name}`;
      const returnUrl = `${strategyUrl}/return`;
      const handleReturn = this.getHandleReturn({
        Linit: logger.extend("init_direct_saml"),
        name,
        type: "saml",
        update_on_login: strategy.info?.update_on_login ?? false,
        cookie_ttl_s: strategy.info?.cookie_ttl_s,
        login_info: { ...DEFAULT_LOGIN_INFO, ...strategy.conf.login_info },
      });

      this.router.get(
        strategyUrl,
        this.handle_get_api_key,
        async (_req, res) => {
          try {
            res.redirect(
              await this.getDirectSaml(name).getAuthorizeUrlAsync(
                "",
                undefined,
                {},
              ),
            );
          } catch (err) {
            logger.warn(
              `Direct SAML sign-in start failed for '${name}': ${err}`,
            );
            await this.sendPassportLoginError({
              name,
              res,
              err,
              includeDetails: false,
            });
          }
        },
      );

      this.router.post(
        returnUrl,
        express.urlencoded({ extended: false }),
        express.json(),
        async (req, res) => {
          let passportLogin: PassportLogin | undefined;
          try {
            if (typeof req.body?.SAMLResponse !== "string") {
              throw new Error("SAML return is missing SAMLResponse.");
            }
            const result = await this.getDirectSaml(
              name,
            ).validatePostResponseAsync({
              SAMLResponse: req.body.SAMLResponse,
            });
            if (result.loggedOut) {
              throw new Error("Unexpected SAML logout response.");
            }
            if (result.profile == null) {
              throw new Error("SAML response did not include a profile.");
            }
            (req as any).user = passportProfileFromSamlProfile(result.profile);
            await handleReturn(req, res);
          } catch (err) {
            if (err.name !== "PassportLoginError") {
              logger.warn(`Direct SAML sign-in failed for '${name}': ${err}`);
              await this.logSsoReturnDenied({
                name,
                phase: "saml_return",
                err,
                req,
              });
            }
            await this.sendPassportLoginError({
              name,
              res,
              passportLogin,
              err,
              includeDetails: false,
            });
          }
        },
      );

      this.router.get(`${strategyUrl}/metadata`, (_req, res) => {
        try {
          res.type("application/samlmetadata+xml");
          res.send(
            this.getDirectSaml(name).generateServiceProviderMetadata(null),
          );
        } catch (err) {
          logger.warn(`Direct SAML metadata failed for '${name}': ${err}`);
          res.status(500).send("SAML metadata is not available.");
        }
      });

      logger.debug(
        `direct SAML initialization of '${name}' at '${strategyUrl}' successful`,
      );
    }
  }

  // This is not really SSO, but we treat it in a similar way.
  private initImpersonate = () => {
    logger.debug("initImpersonate");
    this.router.get(`${AUTH_BASE}/impersonate`, (req, res) => {
      logger.debug("impersonate: handling an auth_token");
      signInUsingImpersonateToken({ req, res });
    });
  };
}

interface IsPasswordCorrect {
  database: PostgreSQL;
  password: string;
  password_hash?: string;
  account_id?: string;
  email_address?: string;
  allow_empty_password?: boolean;
  cb: (err?, correct?: boolean) => void;
}

// NOTE: simpler clean replacement for this is in packages/server/auth/is-password-correct.ts
//
// Password checking.  opts.cb(undefined, true) if the
// password is correct, opts.cb(error) on error (e.g., loading from
// database), and opts.cb(undefined, false) if password is wrong.  You must
// specify exactly one of password_hash, account_id, or email_address.
// In case you specify password_hash, in addition to calling the
// callback (if specified), this function also returns true if the
// password is correct, and false otherwise; it can do this because
// there is no async IO when the password_hash is specified.
export async function is_password_correct(
  opts: IsPasswordCorrect,
): Promise<void> {
  opts = defaults(opts, {
    database: required,
    password: required,
    password_hash: undefined,
    account_id: undefined,
    email_address: undefined,
    // If true and no password set in account, it matches anything.
    // this is only used when first changing the email address or password
    // in passport-only accounts.
    allow_empty_password: false,
    // cb(err, true or false)
    cb: required,
  });

  const { account_id, email_address } = opts;

  if (opts.password_hash != null) {
    const r = verifyPassword(opts.password, opts.password_hash);
    opts.cb(undefined, r);
  } else if (account_id != null || email_address != null) {
    try {
      const account = await cb2(opts.database.get_account, {
        account_id,
        email_address,
        columns: ["password_hash"],
      });

      if (opts.allow_empty_password && !account.password_hash) {
        if (opts.password && opts.account_id) {
          // Set opts.password as the password, since we're actually
          // setting the email address and password at the same time.
          opts.database.change_password({
            account_id: opts.account_id,
            password_hash: passwordHash(opts.password),
            invalidate_remember_me: false,
            cb: (err) => opts.cb(err, true),
          });
        } else {
          opts.cb(undefined, true);
        }
      } else {
        opts.cb(
          undefined,
          verifyPassword(opts.password, account.password_hash),
        );
      }
    } catch (error) {
      opts.cb(error);
    }
  } else {
    opts.cb(
      "One of password_hash, account_id, or email_address must be specified.",
    );
  }
}

/*
Send a verification email with a verification token in it.
*/
interface VerifyEmailOpts {
  database: PostgreSQL;
  account_id: string;
  only_verify: boolean;
  cb: (err?) => void;
}

export async function verify_email_send_token(opts: VerifyEmailOpts) {
  opts = defaults(opts, {
    database: required,
    account_id: required,
    only_verify: false,
    cb: required,
  });

  try {
    const { token, email_address } = await cb2<{
      token: string;
      email_address: string;
    }>(opts.database.verify_email_create_token, {
      account_id: opts.account_id,
    });
    const settings = await cb2(opts.database.get_server_settings_cached);
    await cb2(welcome_email, {
      to: email_address,
      token,
      only_verify: opts.only_verify,
      settings,
    });
    opts.cb();
  } catch (err) {
    opts.cb(err);
  }
}
