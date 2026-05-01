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

export const KEYWORDS_2025: string[] = [
  "red light therapy device",
  "neck traction device",
  "knee compression sleeve",
  "back posture corrector",
  "cervical neck stretcher",
  "trigger point massage tool",
  "fascia gun mini",
  "eye massager electric",
  "led face mask therapy",
  "microcurrent face lifting device",
  "ice globes face roller",
  "blackhead remover vacuum",
  "sonic facial cleanser",
  "nail care electric drill",
  "resistance loop bands set",
  "ab wheel roller core",
  "grip strength trainer",
  "acupressure mat set",
  "cold plunge portable",
  "sauna blanket infrared",
  "vacuum seal food bags",
  "over door organizer hooks",
  "drawer dividers set",
  "silicone stretch lids",
  "herb stripper kitchen tool",
  "spice rack magnetic",
  "digital kitchen scale",
  "monitor riser stand",
  "cable management clips",
  "ergonomic wrist rest",
  "laptop stand portable",
  "under desk foot rest",
  "blue light glasses",
  "desk pad leather mat",
  "compression packing cubes",
  "travel jewelry organizer",
  "portable luggage scale",
  "neck wallet rfid",
  "reusable shopping bags folding",
  "jump rope weighted",
];

export const KEYWORDS_PER_RUN = 15;

export interface AlibabaSupplier {
  name: string;
  stars: number | null;
  certifications: string[];
  price_per_unit: string;
  moq: string;
  url: string;
}

export interface CustomerObjection {
  objection: string;
  why_it_matters: string;
  how_to_counter: string;
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
  score_rationale: string;
}

export interface ProductReport extends ProductCandidate {
  market_analysis: string;
  customer_objections: CustomerObjection[];
  agent_verdict: string;
  recommended_next_step: string;
  week_generated: string;
}

export type Phase2Output = ProductCandidate[];
export type Phase5Output = ProductReport[];
