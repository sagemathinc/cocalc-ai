import * as cheerio from "cheerio";
import type { NebiusPriceItem } from "./types";

const NEBIUS_PRICING_URL = "https://docs.nebius.com/compute/resources/pricing";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseRegionsFromSectionText(
  text: string,
  configuredRegions: string[],
): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return configuredRegions;
  if (/available in all regions/i.test(normalized)) {
    return configuredRegions;
  }
  const matches = Array.from(
    normalized.matchAll(/\b([a-z]{2}-[a-z]+[0-9])\b/g),
    (match) => match[1],
  );
  return Array.from(new Set(matches));
}

function parseUsdPrice(value: string): string | undefined {
  const normalized = normalizeWhitespace(value).replace(/^\$/, "");
  return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : undefined;
}

export function normalizeNebiusUnitAndPrice(opts: {
  price: string;
  unit: string;
}): { price: string; unit: string } | undefined {
  const normalizedUnit = normalizeWhitespace(opts.unit);
  const amount = Number(opts.price);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (/gpu hour$/i.test(normalizedUnit)) {
    return { price: opts.price, unit: "GPU hour" };
  }
  if (/(?:vcpu|cpu) hour$/i.test(normalizedUnit)) {
    return { price: opts.price, unit: "vCPU hour" };
  }
  if (/gib hour$/i.test(normalizedUnit)) {
    return { price: opts.price, unit: "GiB hour" };
  }
  const monthMatch = normalizedUnit.match(/gib per (\d+) hours/i);
  if (monthMatch) {
    const hours = Number(monthMatch[1]);
    if (!Number.isFinite(hours) || hours <= 0) return undefined;
    return {
      price: String(amount / hours),
      unit: "GiB hour",
    };
  }
  return undefined;
}

function shouldKeepNebiusRow(item: string, tableHtml: string): boolean {
  if (/\.\s*(GPU|CPU|RAM)$/i.test(item)) return true;
  if (/\.\s*(GPU|CPU|RAM)</i.test(tableHtml)) return false;
  return true;
}

export async function fetchNebiusPricingFromDocs(opts: {
  regions?: string[];
}): Promise<NebiusPriceItem[]> {
  const resp = await fetch(NEBIUS_PRICING_URL);
  if (!resp.ok) {
    throw new Error(
      `failed to fetch Nebius pricing docs: HTTP ${resp.status} ${await resp.text()}`,
    );
  }
  const html = await resp.text();
  const $ = cheerio.load(html);
  const configuredRegions = Array.from(
    new Set((opts.regions ?? []).filter(Boolean)),
  );
  const validFrom = new Date().toISOString().slice(0, 10);
  const prices: NebiusPriceItem[] = [];

  $("#content h4").each((_, element) => {
    const heading = normalizeWhitespace($(element).text());
    if (!heading) return;
    const siblings = $(element).nextUntil("h3, h4");
    const tabs = siblings.filter("div.tabs").first();
    if (!tabs.length) return;
    const proseText = normalizeWhitespace(
      siblings.not("div.tabs").text().replace(/\s+/g, " "),
    );
    let regions = parseRegionsFromSectionText(proseText, configuredRegions);
    if (!regions.length) {
      regions = configuredRegions;
    }
    const usdTable = tabs
      .find('div[role="tabpanel"]')
      .first()
      .find("table")
      .first();
    if (!usdTable.length) return;
    const tableHtml = $.html(usdTable);
    usdTable.find("tbody tr").each((__, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;
      const item = normalizeWhitespace($(cells[0]).text());
      const price = parseUsdPrice($(cells[1]).text());
      const unit =
        cells.length >= 3
          ? normalizeWhitespace($(cells[2]).text())
          : "GiB per 730 hours";
      if (!item || !price) return;
      if (!shouldKeepNebiusRow(item, tableHtml)) return;
      const normalized = normalizeNebiusUnitAndPrice({ price, unit });
      if (!normalized) return;
      for (const region of regions) {
        prices.push({
          service: "Compute",
          product: item,
          region,
          price_usd: normalized.price,
          unit: normalized.unit,
          valid_from: validFrom,
        });
      }
    });
  });

  return prices;
}
