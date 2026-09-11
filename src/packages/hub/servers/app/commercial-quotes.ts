/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes } from "node:crypto";
import express, { type Router } from "express";
import LRU from "lru-cache";
import { downloadPublicQuote } from "@cocalc/server/commercial-orders/public-quote";
import { checkAndRecordCount } from "./connector-rate-limit";

export default function initCommercialQuotes(router: Router): void {
  const counts = new LRU<string, number>({ max: 10_001, ttl: 60_000 });
  const path = "/commercial/quotes/download";
  router.use(path, (req, res, next) => {
    res.set({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
    // req.ip follows the hub's configured trusted-proxy policy, not arbitrary headers.
    const ip = createHash("sha256")
      .update(req.ip ?? req.socket.remoteAddress ?? "unknown")
      .digest("hex");
    if (
      !checkAndRecordCount(counts, "global", 200) ||
      !checkAndRecordCount(counts, ip, 30)
    ) {
      res
        .set("Retry-After", "60")
        .status(429)
        .send("Please try again in a minute.");
      return;
    }
    next();
  });
  router.get(path, (_req, res) => {
    const nonce = randomBytes(16).toString("hex");
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    // The fragment is never sent in HTTP URLs/access logs. No third-party assets.
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Download CoCalc quote</title></head><body><h1>Download your CoCalc quote</h1><p id="message">This link gives anyone who has it access to this quote. Keep it private.</p><form method="post"><input type="hidden" name="token" id="token"><button id="download" disabled>Download quote PDF</button></form><noscript>JavaScript is required to open this private download link.</noscript><script nonce="${nonce}">const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(/^[a-f0-9]{64}$/.test(token)){document.getElementById('token').value=token;document.getElementById('download').disabled=false;}else{document.getElementById('message').textContent='This download link is incomplete. Please ask CoCalc support for a new link.';}</script></body></html>`,
      );
  });
  router.post(
    path,
    express.urlencoded({ extended: false, limit: "1kb" }),
    async (req, res) => {
      res.set(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'",
      );
      try {
        const pdf = await downloadPublicQuote(req.body?.token);
        const content = Buffer.from(pdf.content_base64, "base64");
        if (content.length > 2_097_152) throw Error("oversized quote");
        res
          .attachment(pdf.filename.replace(/[^A-Za-z0-9._-]/g, "_"))
          .type("pdf")
          .send(content);
      } catch {
        // Do not log the request body/token or expose internal provider errors.
        res
          .status(404)
          .type("text")
          .send(
            "Quote download unavailable. The link may have expired or been revoked. Please try again in a minute or contact CoCalc support.",
          );
      }
    },
  );
}
