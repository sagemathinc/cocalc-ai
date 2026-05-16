/*
 *  This file is part of CoCalc: Copyright © 2021 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createTransport } from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Message } from "./message";
import getHelpEmail from "./help";
import appendFooter from "./footer";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

export default async function sendEmail(message: Message): Promise<void> {
  let settings: SMTPSettings;
  try {
    settings = await getSMTPSettings();
  } catch (err) {
    throw Error(
      `SMTP email is not properly configured for this server. Contact the site administrator. -- ${err}`,
    );
  }

  if (!message.from) {
    if (settings.from) {
      message.from = settings.from;
    } else {
      message.from = await getHelpEmail(); // fallback
    }
  }
  const server = await getServer(settings);
  const msg = await appendFooter(message);
  await server.sendMail(msg);
}

let server: undefined | Transporter = undefined;
let cacheSettings = ""; // what settings were used to compute cached server.
async function getServer(settings): Promise<Transporter> {
  const s = JSON.stringify(settings);
  if (server !== undefined && s == cacheSettings) return server;
  server = await createTransport({
    host: settings.server,
    port: settings.port,
    secure: settings.secure,
    auth: {
      user: settings.login,
      pass: settings.password,
    },
  });
  cacheSettings = s;
  return server;
}

interface SMTPSettings {
  server: string;
  login: string;
  password: string;
  secure: boolean;
  from?: string;
  port?: string;
}

async function getEmailServerSettings(): Promise<SMTPSettings> {
  const settings = await getServerSettings();
  return {
    server: settings.email_smtp_server,
    login: settings.email_smtp_login,
    password: settings.email_smtp_password,
    secure: settings.email_smtp_secure,
    from: settings.email_smtp_from,
    port: settings.email_smtp_port,
  };
}

async function getSMTPSettings(): Promise<SMTPSettings> {
  const settings: SMTPSettings = await getEmailServerSettings();

  if (!settings.server) {
    throw Error(`SMTP server must be configured`);
  }
  if (!settings.login) {
    throw Error(`SMTP username must be configured`);
  }
  if (!settings.password) {
    throw Error(`SMTP password must be configured`);
  }

  return settings;
}
