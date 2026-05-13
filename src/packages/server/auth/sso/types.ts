/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Router } from "express";

import { PostgreSQL } from "@cocalc/database/postgres/types";
import type { LoginInfoDerivator } from "@cocalc/database/settings/auth-sso-types";

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

export type LoginInfo = Readonly<{
  id: string | LoginInfoDerivator<string>; // id is required!
  first_name?: string | LoginInfoDerivator<string>;
  last_name?: string | LoginInfoDerivator<string>;
  full_name?: string | LoginInfoDerivator<string>;
  emails?: string | LoginInfoDerivator<string[]>;
  _sep?: string;
}>;
