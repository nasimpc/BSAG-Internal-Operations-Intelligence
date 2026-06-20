export type SourceId =
  | 'vbn_realtime'
  | 'vbn_notices'
  | 'bsag'
  | 'vmz_rss'
  | 'vmz_web'
  | 'vmz_pdf'
  | 'bremen_events';

export interface Provenance {
  source: SourceId;
  sourceUrl: string;
  fetchedAt: string;
  publishedAt?: string;
  contentHash?: string;
}

export interface DelayObservation {
  line_id: string;
  entity_id?: string;
  direction?: string;
  stop_name?: string;
  scheduled_at?: string;
  observed_at: string;
  delay_seconds: number;
  has_usable_delay?: boolean;
  schedule_relationship?: 'scheduled' | 'skipped' | 'canceled';
  trip_id?: string;
  stop_sequence?: number;
  update_count?: number;
  provenance: Provenance;
}

export interface ServiceNotice {
  id: string;
  title: string;
  summary: string;
  details?: string;
  lines: string[];
  stop_names: string[];
  valid_from?: string;
  valid_to?: string;
  severity: 'info' | 'warning' | 'critical';
  provenance: Provenance;
}

export interface ExternalImpact {
  id: string;
  title: string;
  summary: string;
  details?: string;
  corridor_ids: string[];
  starts_at?: string;
  ends_at?: string;
  category: 'roadworks' | 'event' | 'incident' | 'other';
  severity: 'low' | 'moderate' | 'high' | 'severe';
  provenance: Provenance;
}

export interface SourceWarning {
  source: SourceId;
  code: string;
  message: string;
  occurred_at: string;
  retryable: boolean;
  stale_cache_used?: boolean;
  stale_age_seconds?: number;
}

export interface SourceStatus {
  source: SourceId;
  fetched_at?: string;
  age_seconds?: number;
  stale: boolean;
}

export interface LineHealth {
  line_id: string;
  snapshot_at: string;
  trip_count: number;
  observed_trip_count: number;
  coverage_ratio: number;
  average_delay_seconds: number;
  median_delay_seconds: number;
  p95_delay_seconds: number;
  max_delay_seconds: number;
  on_time_percentage: number;
  cancellations?: number;
  skipped_stops?: number;
  warnings: SourceWarning[];
}

export interface RiskContribution {
  kind:
    | 'delay'
    | 'on_time'
    | 'coverage'
    | 'notice'
    | 'roadwork'
    | 'event'
    | 'overlap';
  points: number;
  reason: string;
}

export interface RiskWarning {
  code: string;
  message: string;
}

export interface RiskAssessment {
  target_type: 'line' | 'corridor';
  target_id: string;
  score: number;
  band: 'low' | 'moderate' | 'high' | 'severe';
  contributions: RiskContribution[];
  confidence: 'low' | 'medium' | 'high';
  warnings: RiskWarning[];
}

export interface ToolEnvelope<T> {
  generated_at: string;
  timezone: 'Europe/Berlin';
  status: 'complete' | 'partial';
  data: T;
  sources: SourceStatus[];
  warnings: SourceWarning[];
}
