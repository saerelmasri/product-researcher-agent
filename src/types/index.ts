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

export interface CustomerObjection {
  category: "Shipping" | "Quality" | "Price" | "Trust";
  customer_voice: string;
  why_it_matters_in_lebanon: string;
  counter: string;
}

// ── Phase 3 output types ───────────────────────────────────────────────────────

export interface ProductAnalysisIdentification {
  product_name: string;
  product_description: string;
  category: string;
  appears_generic: boolean;
  appears_proprietary: boolean;
  generic_vs_proprietary_reasoning: string;
}

export interface ProductAnalysisWinningAssessment {
  verdict: "strong_winner" | "likely_winner" | "testing" | "weak_signal";
  verdict_reasoning: string;
  scaling_signal_quality: "high" | "medium" | "low";
  scaling_signal_reasoning: string;
  durability_assessment: "evergreen" | "seasonal" | "trend" | "fad";
  durability_reasoning: string;
  confidence_signals: string[];
  concern_signals: string[];
}

export interface PositioningAngle {
  angle: string;
  example_from_ad: string;
}

export interface ProductAnalysisIntelligence {
  problems_solved: string[];
  audience_segments: string[];
  emotional_drivers: string[];
  positioning_angles: PositioningAngle[];
  main_hook: string;
  secondary_hooks: string[];
  creative_directions: string[];
  differentiation_angle: string;
  differentiation_copyable: boolean;
  market_introduction_ideas: string[];
  private_label_fit?: "high" | "medium" | "low"; // optional — add to Phase 3 schema to populate
}

export interface ProductAnalysisEconomics {
  stated_price_in_ads: string | null;
  category_cost_range_usd: string;
  category_shipping_range_usd: string;
  confidence: "high" | "medium" | "low";
  based_on: string;
  margin_universe_check: string;
  viable_for_private_label: boolean | "depends_on_sourcing";
}

export interface ProductAnalysis {
  identification: ProductAnalysisIdentification;
  winning_product_assessment: ProductAnalysisWinningAssessment;
  product_intelligence: ProductAnalysisIntelligence;
  economics_estimate: ProductAnalysisEconomics;
  manual_review_needed: string[];
}

export interface ScalingBreakdown {
  active_ad_count: number;
  max_days_running: number;
  ad_count: number;
  formula_version: string;
}

// ── Phase 4 output types ───────────────────────────────────────────────────────

export type CompetitionLevel = "None" | "Light" | "Moderate" | "Heavy" | "Unknown";

export interface BrandCompetitor {
  page_id: string;
  page_name: string;
  ad_count: number;
  active_ad_count: number;
  max_days_running: number;
  first_seen: string;    // ISO date string
  last_seen: string;     // ISO date string
  sample_ad_url: string;
}

export interface LebanonCompetition {
  search_terms_used: string[];
  total_competitors: number;
  active_competitors: number;
  serious_competitors: number;
  competitors: BrandCompetitor[];
  competition_level: CompetitionLevel;
  manual_check_url: string;
  signals_note: string;
  thresholds_version: string;
  computed_at: string;   // ISO timestamp
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

  // Competition data — null until Phase 4 runs
  lebanon_competition: LebanonCompetition | null;

  // Concrete items a human should verify before sourcing
  manual_review_needed: string[];
}

export interface RecommendedNextStep {
  action: string;           // specific action verb + specific target
  why: string;              // one sentence on why this action first
  success_criteria: string; // how you'll know it worked
  kill_criteria: string;    // what would tell you to stop
}

export type ProductReport = ProductCandidate & {
  market_analysis: string;
  customer_objections: CustomerObjection[];
  agent_verdict: string;
  recommended_next_step: RecommendedNextStep;
  week_generated: string;
};

export type Phase2Output = ProductCandidate[]; // output of Phase 3 filter
export type Phase3Output = ProductCandidate[];
export type Phase5Output = ProductReport[];    // output of Phase 5 analysis
