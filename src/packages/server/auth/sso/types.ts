/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Router } from "express";

import { Strategy as SAMLStrategyNew } from "@node-saml/passport-saml";
import { AuthenticateOptions, Strategy as PassportStrategy } from "passport";

import { PostgreSQL } from "@cocalc/database/postgres/types";
import type {
  LoginInfoDerivator,
  PassportTypes,
} from "@cocalc/database/settings/auth-sso-types";

export interface InitPassport {
  router: Router;
  database: PostgreSQL;
  host: string;
  cb: (err?) => void;
}

export interface PassportManagerOpts {
  router: Router;
  database: PostgreSQL;
  host: string;
}

export type PassportStrategyConstructorType =
  | typeof PassportStrategy
  | typeof SAMLStrategyNew;

export interface StrategyInstanceOpts {
  type: PassportTypes;
  opts: { [key: string]: any };
  userinfoURL: string | undefined;
  PassportStrategyConstructor: PassportStrategyConstructorType;
}

export interface StrategyConf {
  name: string; // our custom name
  type: PassportTypes; // e.g. "saml"
  PassportStrategyConstructor: PassportStrategyConstructorType;
  extra_opts?: {
    [key: string]: unknown;
  };
  auth_opts?: AuthenticateOptions;
  // return type has to partially fit with passport_login
  login_info: LoginInfo;
  userinfoURL?: string; // OAuth2, to get a profile
  update_on_login?: boolean; // if true, update the user's profile on login
  cookie_ttl_s?: number; // how long the remember_me cookied lasts (default is a month or so)
}

export type LoginInfo = Readonly<{
  id: string | LoginInfoDerivator<string>; // id is required!
  first_name?: string | LoginInfoDerivator<string>;
  last_name?: string | LoginInfoDerivator<string>;
  full_name?: string | LoginInfoDerivator<string>;
  emails?: string | LoginInfoDerivator<string[]>;
  _sep?: string;
}>;
