// ── Flow A types ──────────────────────────────────────────────────────────────

export interface CandidateNiche {
  niche: string;
  examples: string[];
  privateLabelViable: string;
  lebanonFit: number; // 1–5
  alibabaPrice: string;
  sellingPrice: string;
  reasoning: string;
}

export type TrendStatus = "RISING" | "STABLE" | "DECLINING";

export interface ValidatedNiche {
  niche: string;
  status: TrendStatus;
  change: string; // e.g. "+23%" or "-5%"
}

// niche name → array of keyword strings
export type DiscoveredKeywords = Record<string, string[]>;

// ── Flow B types ───────────────────────────────────────────────────────────────

export interface MetaAdRange {
  lower_bound: number;
  upper_bound: number;
}

export interface MetaAd {
  ad_id: string;
  page_name: string;
  ad_creative_body: string;
  ad_delivery_start_time: string;
  ad_delivery_stop_time: string | null;
  impressions: MetaAdRange | null;
  spend: MetaAdRange | null;
  search_term_used: string;
}

export interface MetaAdLibraryRawAd {
  id: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  impressions?: { lower_bound?: string; upper_bound?: string };
  spend?: { lower_bound?: string; upper_bound?: string };
  publisher_platforms?: string[];
}

export interface MetaAdLibraryResponse {
  data?: MetaAdLibraryRawAd[];
  paging?: { cursors?: { before?: string; after?: string } };
  error?: { message: string; type: string; code: number };
}

export type Phase1Output = MetaAd[];

export interface RunState {
  weekIndex: number;
  lastRunAt: string | null;
}

export interface AlibabaSupplier {
  name: string;
  stars: number | null;
  review_count: number;
  certifications: string[];
  trade_assurance: boolean;
  verified: boolean;
  price_per_unit: string;
  moq: string;
  url: string;
}

export interface CustomerObjection {
  category: "Shipping" | "Quality" | "Price" | "Trust";
  customer_voice: string;       // written as the Lebanese customer would say it
  why_it_matters_in_lebanon: string;
  counter: string;              // concrete action for the product page / ad
}

export interface ProductCandidate {
  product_name: string;
  niche: string;
  score: number;
  verdict: "Investigate" | "Watch" | "Skip";
  selling_price_usd: number;
  alibaba_cost_range: string;
  estimated_margin_pct: number;
  weight_kg: number;
  lebanon_competition: "Low" | "Medium" | "High" | "Unknown";
  has_recurring_purchase: boolean;
  cross_sell_opportunities: string[];
  source_ads: MetaAd[];
  alibaba_suppliers: AlibabaSupplier[];
  alibaba_search_url: string;
  score_rationale: string;
}

export interface ProductReport extends ProductCandidate {
  market_analysis: string;
  customer_objections: CustomerObjection[];
  agent_verdict: string;
  recommended_next_step: string;
  week_generated: string;
}

export type Phase2Output = ProductCandidate[]; // legacy alias — output of Phase 3 filter
export type Phase5Output = ProductReport[];    // legacy alias — output of Phase 6 analysis
export type Phase3Output = ProductCandidate[];
export type Phase6Output = ProductReport[];
