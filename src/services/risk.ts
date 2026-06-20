import type {
  ExternalImpact,
  LineHealth,
  RiskAssessment,
  RiskContribution,
  ServiceNotice,
  SourceStatus,
} from '../domain/models.js';

const CONTRIBUTION_ORDER: RiskContribution['kind'][] = [
  'delay',
  'on_time',
  'coverage',
  'notice',
  'roadwork',
  'event',
  'overlap',
];

export interface RiskConfig {
  maxDelaySeconds: number;
  delayPoints: number;
  onTimePoints: number;
  noticePoints: {
    info: number;
    warning: number;
    critical: number;
  };
  roadworkPoints: {
    low: number;
    moderate: number;
    high: number;
    severe: number;
  };
  eventPoints: {
    low: number;
    moderate: number;
    high: number;
    severe: number;
  };
  overlapPoints: number;
  lowCoverageThreshold: number;
  lowCoveragePoints: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxDelaySeconds: 1_200,
  delayPoints: 30,
  onTimePoints: 15,
  noticePoints: {
    info: 4,
    warning: 12,
    critical: 25,
  },
  roadworkPoints: {
    low: 5,
    moderate: 10,
    high: 15,
    severe: 20,
  },
  eventPoints: {
    low: 2,
    moderate: 6,
    high: 10,
    severe: 10,
  },
  overlapPoints: 10,
  lowCoverageThreshold: 0.5,
  lowCoveragePoints: 5,
};

export interface AssessRiskInput {
  target_type: 'line' | 'corridor';
  target_id: string;
  line_health?: LineHealth;
  notices: ServiceNotice[];
  impacts: ExternalImpact[];
  source_statuses: SourceStatus[];
  match_quality: 'exact' | 'phrase' | 'none';
}

export function bandForScore(score: number): RiskAssessment['band'] {
  if (score >= 75) {
    return 'severe';
  }

  if (score >= 50) {
    return 'high';
  }

  if (score >= 25) {
    return 'moderate';
  }

  return 'low';
}

export function assessRisk(
  input: AssessRiskInput,
  config: RiskConfig,
): RiskAssessment {
  const contributions: RiskContribution[] = [];
  const warnings: RiskAssessment['warnings'] = [];
  const lineHealth = input.line_health;

  if (lineHealth !== undefined && lineHealth.trip_count > 0) {
    const delayPoints = clamp(
      Math.round(
        (lineHealth.average_delay_seconds / config.maxDelaySeconds) *
          config.delayPoints,
      ),
      0,
      config.delayPoints,
    );

    if (delayPoints > 0) {
      contributions.push({
        kind: 'delay',
        points: delayPoints,
        reason: `Average delay is ${String(lineHealth.average_delay_seconds)} seconds.`,
      });
    }

    const onTimePoints = clamp(
      Math.round(
        ((100 - lineHealth.on_time_percentage) / 100) * config.onTimePoints,
      ),
      0,
      config.onTimePoints,
    );

    if (onTimePoints > 0) {
      contributions.push({
        kind: 'on_time',
        points: onTimePoints,
        reason: `Only ${String(lineHealth.on_time_percentage)}% of observed trips were on time.`,
      });
    }

    if (
      lineHealth.coverage_ratio > 0 &&
      lineHealth.coverage_ratio < config.lowCoverageThreshold
    ) {
      contributions.push({
        kind: 'coverage',
        points: config.lowCoveragePoints,
        reason: `Realtime coverage is only ${String(
          Math.round(lineHealth.coverage_ratio * 100),
        )}%.`,
      });
    }
  }

  const noticePoints = input.notices.reduce(
    (highest, notice) =>
      Math.max(highest, config.noticePoints[notice.severity]),
    0,
  );

  if (noticePoints > 0) {
    contributions.push({
      kind: 'notice',
      points: noticePoints,
      reason: `Service notices include ${highestNoticeSeverity(input.notices)} severity changes.`,
    });
  }

  const roadworkImpacts = input.impacts.filter(
    (impact) => impact.category !== 'event',
  );
  const roadworkPoints = roadworkImpacts.reduce(
    (highest, impact) =>
      Math.max(highest, config.roadworkPoints[impact.severity]),
    0,
  );

  if (roadworkPoints > 0) {
    contributions.push({
      kind: 'roadwork',
      points: roadworkPoints,
      reason: `External impacts include ${highestImpactSeverity(roadworkImpacts)} roadwork or traffic factors.`,
    });
  }

  const eventImpacts = input.impacts.filter(
    (impact) => impact.category === 'event',
  );
  const eventPoints = eventImpacts.reduce(
    (highest, impact) => Math.max(highest, config.eventPoints[impact.severity]),
    0,
  );

  if (eventPoints > 0) {
    contributions.push({
      kind: 'event',
      points: eventPoints,
      reason: `Major events may increase demand or disruption risk.`,
    });
  }

  if (
    (lineHealth?.trip_count ?? 0) > 0 &&
    (lineHealth?.average_delay_seconds ?? 0) > 0 &&
    roadworkPoints > 0
  ) {
    contributions.push({
      kind: 'overlap',
      points: config.overlapPoints,
      reason: 'Current or recent realtime delays and external impacts overlap.',
    });
  }

  const score = Math.min(
    100,
    contributions.reduce((sum, contribution) => sum + contribution.points, 0),
  );
  const freshSources = input.source_statuses.filter((status) => !status.stale);

  if (
    input.source_statuses.length < 3 ||
    freshSources.length !== input.source_statuses.length
  ) {
    warnings.push({
      code: 'MISSING_SOURCE_FRESHNESS',
      message: 'One or more supporting sources were stale or unavailable.',
    });
  }

  return {
    target_type: input.target_type,
    target_id: input.target_id,
    score,
    band: bandForScore(score),
    contributions: contributions.sort(compareContributions),
    confidence: computeConfidence(
      input.match_quality,
      input.source_statuses,
      lineHealth?.trip_count ?? 0,
    ),
    warnings,
  };
}

function computeConfidence(
  matchQuality: AssessRiskInput['match_quality'],
  sourceStatuses: SourceStatus[],
  tripCount: number,
): RiskAssessment['confidence'] {
  if (
    tripCount === 0 ||
    sourceStatuses.some((status) => status.stale) ||
    matchQuality === 'none'
  ) {
    return 'low';
  }

  if (matchQuality === 'exact') {
    return 'high';
  }

  return 'medium';
}

function compareContributions(
  left: RiskContribution,
  right: RiskContribution,
): number {
  if (left.points !== right.points) {
    return right.points - left.points;
  }

  return (
    CONTRIBUTION_ORDER.indexOf(left.kind) -
    CONTRIBUTION_ORDER.indexOf(right.kind)
  );
}

function highestNoticeSeverity(
  notices: ServiceNotice[],
): ServiceNotice['severity'] {
  if (notices.some((notice) => notice.severity === 'critical')) {
    return 'critical';
  }

  if (notices.some((notice) => notice.severity === 'warning')) {
    return 'warning';
  }

  return 'info';
}

function highestImpactSeverity(
  impacts: ExternalImpact[],
): ExternalImpact['severity'] {
  if (impacts.some((impact) => impact.severity === 'severe')) {
    return 'severe';
  }

  if (impacts.some((impact) => impact.severity === 'high')) {
    return 'high';
  }

  if (impacts.some((impact) => impact.severity === 'moderate')) {
    return 'moderate';
  }

  return 'low';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
