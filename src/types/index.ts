// ── Flow A types ──────────────────────────────────────────────────────────────

export interface CandidateNiche {
  niche: string;
  rationale: string;
  examples: string[];
  priceRange: string;
  upsellOrRepeat: string;
  lebanonImportRisk: "low" | "medium" | "high";
  lebanonImportNotes: string;
}

export type TrendStatus = "RISING" | "STABLE" | "DECLINING";

export interface ValidatedNiche {
  niche: string;
  status: TrendStatus;
  change: string; // e.g. "+23%" or "-5%"
}

export interface DiscoveredKeyword {
  term: string;
  type: "category" | "hook" | "mechanism" | "vernacular";
}

export interface DiscoveredKeywordsByNiche {
  niche: string;
  keywords: DiscoveredKeyword[];
}

export interface DiscoveredKeywordsFile {
  keywordsByNiche: DiscoveredKeywordsByNiche[];
}

// ── Flow B types ───────────────────────────────────────────────────────────────

export interface MetaAd {
  ad_id: string;
  page_id: string;
  page_name: string;
  ad_creative_body: string;
  has_creative_text: boolean;
  ad_snapshot_url: string;
  publisher_platforms: string[];
  ad_delivery_start_time: string;
  ad_delivery_stop_time: string | null;
  days_running: number;
  is_still_active: boolean;
  search_terms_used: string[];
  search_term_types: Array<DiscoveredKeyword["type"] | null>;
  page_ad_count: number;
}

export interface BrandRecord {
  page_id: string;
  page_name: string;
  ad_count: number;
  active_ad_count: number;
  avg_days_running: number;
  max_days_running: number;
  niches_hit: string[];
  keywords_hit: string[];
  ad_ids: string[];
}

export interface MetaAdLibraryRawAd {
  id: string;
  page_id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_snapshot_url?: string;
  publisher_platforms?: string[];
}

export interface MetaAdLibraryResponse {
  data?: MetaAdLibraryRawAd[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
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
  customer_voice: string;
  why_it_matters_in_lebanon: string;
  counter: string;
}

// ── Phase 3 output types ───────────────────────────────────────────────────────

export interface ProductAnalysis {
  product_name: string;
  product_description: string;
  category: string;
  stated_price: string | null;
  problem_solved: string;
  main_hook: string;
  secondary_hooks: string[];
  appears_generic: boolean;
  appears_proprietary: boolean;
  generic_vs_proprietary_reasoning: string;
  differentiation_angle: string;
  differentiation_copyable: boolean;
  single_product_brand: boolean | "unclear";
  brand_observations: string;
  private_label_fit: "high" | "medium" | "low";
  private_label_reasoning: string;
  trend_or_evergreen: "trend" | "evergreen" | "unclear";
  trend_evergreen_reasoning: string;
  red_flags: string[];
  creative_quality_signal: string;
  notes_for_manual_review: string;
}

export interface ScalingBreakdown {
  active_ad_count: number;
  max_days_running: number;
  ad_count: number;
  formula_version: string;
}

export interface ProductCandidate {
  // From BrandRecord (Phase 2)
  page_id: string;
  page_name: string;
  ad_count: number;
  active_ad_count: number;
  avg_days_running: number;
  max_days_running: number;
  niches_hit: string[];
  keywords_hit: string[];

  // Computed scaling signal
  scaling_score: number;
  scaling_breakdown: ScalingBreakdown;

  // From Claude (null if analysis failed or skipped)
  product_analysis: ProductAnalysis | null;
  analysis_status: "success" | "failed" | "skipped_no_text";

  // Source data for downstream phases (IDs only — full ads remain in ads.json)
  source_ad_ids: string[];

  // Stubs filled by downstream phases
  lebanon_competition: "Unknown" | "Low" | "Medium" | "High";
  alibaba_suppliers: AlibabaSupplier[];
  alibaba_search_url: string;

  // Concrete items a human should verify before sourcing
  manual_review_needed: string[];
}

export interface ProductReport extends ProductCandidate {
  market_analysis: string;
  customer_objections: CustomerObjection[];
  agent_verdict: string;
  recommended_next_step: string;
  week_generated: string;
}

export type Phase2Output = ProductCandidate[]; // output of Phase 3 filter
export type Phase5Output = ProductReport[];    // output of Phase 6 analysis
export type Phase3Output = ProductCandidate[];
export type Phase6Output = ProductReport[];
