import axios from "axios";
import { load } from "cheerio";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { AlibabaSupplier, ProductCandidate } from "../types";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const CANDIDATES_PATH = path.join(DATA_DIR, "candidates.json");

const REQUEST_DELAY_MS = 2500;
const MAX_SUPPLIERS = 5;
const MIN_STARS = 4.0;
const MIN_REVIEWS = 50;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
];

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchUrl(productName: string): string {
  return `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(productName)}&tab=supplier`;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 20_000,
      responseType: "text",
      headers: {
        "User-Agent": pickUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
    });
    return typeof res.data === "string" ? res.data : null;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    log.warn(`Alibaba fetch failed`, { url, status, error: (err as Error).message });
    return null;
  }
}

function coerceString(val: unknown): string {
  if (typeof val === "string") return val.trim();
  if (typeof val === "number") return String(val);
  return "";
}

function isSupplierLike(node: unknown): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const keys = Object.keys(node as Record<string, unknown>);
  return keys.some((k) =>
    ["companyName", "supplierName", "company_name", "supplierInfo", "subjectId"].includes(k),
  );
}

function mapJsonNodeToSupplier(node: unknown): AlibabaSupplier | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const n = node as Record<string, unknown>;

  const name = coerceString(
    n.companyName ?? n.supplierName ?? n.company_name ?? n.name ?? "",
  );
  if (!name) return null;

  const starsRaw =
    (n.supplierAssessment as Record<string, unknown> | undefined)?.overallLevel ??
    n.stars ??
    n.rating ??
    n.score ??
    null;
  const starsNum = starsRaw !== null ? parseFloat(String(starsRaw)) : NaN;
  const stars = Number.isNaN(starsNum) ? null : starsNum;

  const reviewRaw = n.reviewCount ?? n.review_count ?? n.commentCount ?? 0;
  const review_count =
    typeof reviewRaw === "number" ? reviewRaw : parseInt(String(reviewRaw), 10) || 0;

  const trade_assurance = !!(
    n.tradeAssurance ??
    n.trade_assurance ??
    n.tradeAssuranceAmount ??
    n.isTradeAssurance
  );
  const verified = !!(
    n.isGoldSupplier ??
    n.goldSupplier ??
    n.verifiedBadge ??
    n.isVerified ??
    n.verifiedSupplier
  );

  const certifications: string[] = [];
  const rawCerts = n.certifications ?? n.certs ?? n.qualifications;
  if (Array.isArray(rawCerts)) {
    for (const c of rawCerts) {
      if (typeof c === "string" && c.trim()) certifications.push(c.trim());
      else if (c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string") {
        certifications.push(((c as Record<string, unknown>).name as string).trim());
      }
    }
  }

  const price_per_unit = coerceString(n.priceRange ?? n.price ?? n.productPriceRange ?? "");
  const moq = coerceString(n.minOrderQuantity ?? n.moq ?? n.minOrder ?? "");
  const rawHref = coerceString(n.supplierUrl ?? n.url ?? n.companyUrl ?? n.href ?? "");
  const url = rawHref.startsWith("http") ? rawHref : rawHref ? `https:${rawHref}` : "";

  return { name, stars, review_count, certifications, trade_assurance, verified, price_per_unit, moq, url };
}

// Walk a parsed JSON blob up to 8 levels deep looking for arrays of supplier objects.
function walkForSuppliers(node: unknown, depth = 0): AlibabaSupplier[] {
  if (depth > 8 || node === null || typeof node !== "object") return [];

  if (Array.isArray(node)) {
    if (node.length > 0 && isSupplierLike(node[0])) {
      const mapped = node
        .map(mapJsonNodeToSupplier)
        .filter((s): s is AlibabaSupplier => s !== null);
      if (mapped.length > 0) return mapped;
    }
    for (const item of node) {
      const found = walkForSuppliers(item, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }

  for (const val of Object.values(node as Record<string, unknown>)) {
    const found = walkForSuppliers(val, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function extractFromJsonBlobs(html: string): AlibabaSupplier[] {
  // Strategy 1: Next.js data island
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const suppliers = walkForSuppliers(JSON.parse(nextMatch[1]));
      if (suppliers.length > 0) return suppliers;
    } catch (_) {}
  }

  // Strategy 2: window.__INIT_DATA__
  const initMatch = html.match(/window\.__INIT_DATA__\s*=\s*(\{[\s\S]*?\});\s*(?:window|var|\/\/|\n)/);
  if (initMatch) {
    try {
      const suppliers = walkForSuppliers(JSON.parse(initMatch[1]));
      if (suppliers.length > 0) return suppliers;
    } catch (_) {}
  }

  // Strategy 3: any script tag containing supplierName / companyName key
  const scriptTags = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const match of scriptTags) {
    const body = match[1];
    if (!body.includes("companyName") && !body.includes("supplierName")) continue;
    const jsonMatch = body.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) continue;
    try {
      const suppliers = walkForSuppliers(JSON.parse(jsonMatch[1]));
      if (suppliers.length > 0) return suppliers;
    } catch (_) {}
  }

  return [];
}

// Cheerio fallback using Alibaba's supplier card HTML structure.
// Selectors are best-effort and may need tuning if Alibaba updates their markup.
function extractFromHtml(html: string): AlibabaSupplier[] {
  const $ = load(html);
  const suppliers: AlibabaSupplier[] = [];

  // Try several known card selector patterns in order of specificity
  const cardSelectors = [
    ".organic-list-offer-outter",
    ".organic-list-offer__wrapper",
    ".supplier-card",
    "[data-component='supplier-card']",
    ".search-card-e-info",
  ];

  const matchedSelector = cardSelectors.find((sel) => $(sel).length > 0);
  if (!matchedSelector) return [];
  const cards = $(matchedSelector);

  cards.each((_i, el) => {
    const card = $(el);

    const name = card
      .find(
        ".search-card-e-company__name, .company-name-text, .supplier-name, [class*=company-name]",
      )
      .first()
      .text()
      .trim();
    if (!name) return;

    const starsText = card
      .find("[class*=star-rate], [class*=starRate], [class*=rating-num]")
      .first()
      .text()
      .trim();
    const starsNum = parseFloat(starsText);
    const stars = Number.isNaN(starsNum) ? null : starsNum;

    const reviewText = card
      .find("[class*=review-count], [class*=reviewCount], [class*=rating-count]")
      .first()
      .text()
      .replace(/[^0-9]/g, "");
    const review_count = parseInt(reviewText, 10) || 0;

    const trade_assurance =
      card.find("[class*=trade-assurance], [class*=tradeAssurance], [alt*='Trade Assurance']")
        .length > 0;

    const verified =
      card.find("[class*=gold-supplier], [class*=goldSupplier], [class*=verified-supplier]")
        .length > 0;

    const certifications: string[] = [];
    card.find("[class*=cert-name], [class*=certName]").each((_j, c) => {
      const t = $(c).text().trim();
      if (t) certifications.push(t);
    });

    const price_per_unit = card
      .find("[class*=price-range], [class*=priceRange], [class*=price]")
      .first()
      .text()
      .trim();

    const moq = card
      .find("[class*=min-order], [class*=minOrder], [class*=moq]")
      .first()
      .text()
      .trim();

    const rawHref = card.find("a[href*=alibaba]").first().attr("href") ?? "";
    const url = rawHref.startsWith("http") ? rawHref : rawHref ? `https:${rawHref}` : "";

    suppliers.push({
      name,
      stars,
      review_count,
      certifications,
      trade_assurance,
      verified,
      price_per_unit,
      moq,
      url,
    });
  });

  return suppliers;
}

export function qualityFilter(suppliers: AlibabaSupplier[]): AlibabaSupplier[] {
  return suppliers.filter((s) => {
    if (!s.verified) return false;
    if (!s.trade_assurance) return false;
    if (s.stars !== null && s.stars < MIN_STARS) return false;
    if (s.review_count < MIN_REVIEWS) return false;
    return true;
  });
}

export async function fetchSuppliersForProduct(
  productName: string,
): Promise<AlibabaSupplier[]> {
  const url = buildSearchUrl(productName);
  log.info(`Fetching Alibaba suppliers for "${productName}"`);

  const html = await fetchPage(url);
  if (!html) return [];

  if (html.length < 5_000 || /captcha|robot|challenge/i.test(html)) {
    log.warn(`Bot-challenge detected for "${productName}" — skipping`);
    return [];
  }

  let raw = extractFromJsonBlobs(html);
  const method = raw.length > 0 ? "JSON blob" : "HTML";
  if (raw.length === 0) raw = extractFromHtml(html);

  if (raw.length === 0) {
    log.warn(
      `No supplier data parsed for "${productName}" — page structure may have changed. ` +
        `Inspect the HTML and tune selectors in phase4-suppliers.ts.`,
    );
    return [];
  }

  log.info(
    `  ${raw.length} raw suppliers found via ${method} → applying quality filter`,
  );
  const filtered = qualityFilter(raw);
  const top = filtered.slice(0, MAX_SUPPLIERS);
  log.info(`  ${filtered.length} passed filter → keeping top ${top.length}`);
  return top;
}

async function main(): Promise<void> {
  if (!fs.existsSync(CANDIDATES_PATH)) {
    log.error(
      `data/candidates.json not found at ${CANDIDATES_PATH}. Run Phase 2 or Phase 2.1 first.`,
    );
    process.exit(1);
  }

  let candidates: ProductCandidate[];
  try {
    candidates = JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf-8")) as ProductCandidate[];
  } catch (err) {
    log.error("Failed to parse data/candidates.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    log.error("data/candidates.json is empty. Run Phase 2 or Phase 2.1 first.");
    process.exit(1);
  }

  log.info(`Phase 4 starting`, { products: candidates.length });

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const searchUrl = buildSearchUrl(c.product_name);
    c.alibaba_search_url = searchUrl;
    const suppliers = await fetchSuppliersForProduct(c.product_name);
    c.alibaba_suppliers = suppliers;
    if (suppliers.length > 0) {
      log.info(`"${c.product_name}" → ${suppliers.length} suppliers stored`);
    } else {
      log.info(`"${c.product_name}" → 0 suppliers (check manually: ${searchUrl})`);
    }
    if (i < candidates.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidates, null, 2), "utf-8");
  log.info(`Phase 4 complete. Updated ${CANDIDATES_PATH}`);

  log.info("Summary:");
  candidates.forEach((c) => {
    if (c.alibaba_suppliers.length > 0) {
      log.info(`  ${c.product_name}: ${c.alibaba_suppliers.length} suppliers`);
    } else {
      log.info(`  ${c.product_name}: manual check → ${c.alibaba_search_url}`);
    }
  });
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 4 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}
