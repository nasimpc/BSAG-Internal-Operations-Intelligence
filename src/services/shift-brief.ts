import { TZDate } from '@date-fns/tz';

import type { Corridor } from '../config/corridors.js';
import type {
  ExternalImpact,
  RiskAssessment,
  ServiceNotice,
  SourceStatus,
  SourceWarning,
} from '../domain/models.js';
import type { SourceOutcome } from '../domain/result.js';
import type { Clock } from '../shared/clock.js';
import { InputError } from '../shared/dates.js';
import type {
  DraftPassengerInformationInput,
  PassengerInformationDraft,
} from './passenger-information.js';
import type { AssessRiskInput, RiskConfig } from './risk.js';

const BERLIN_TIMEZONE = 'Europe/Berlin';

export interface ShiftWindow {
  start: string;
  end: string;
}

export interface ShiftOverlap {
  line_id: string;
  impact_ids: string[];
  summary: string;
}

export interface ShiftBrief {
  date: string;
  shift_window: ShiftWindow;
  baseline_at: string;
  corridor_ids: string[];
  candidate_lines: string[];
  line_assessments: RiskAssessment[];
  corridor_assessments: RiskAssessment[];
  major_events: ExternalImpact[];
  overlaps: ShiftOverlap[];
  communications: PassengerInformationDraft[];
  operational_actions: string[];
}

export interface ShiftBriefBuildInput {
  date: string;
  corridors?: string[];
  include_comms_draft?: boolean;
}

export interface ShiftBriefServiceOptions {
  assessRisk(input: AssessRiskInput, config: RiskConfig): RiskAssessment;
  clock: Clock;
  corridors: ReadonlyArray<Readonly<Corridor>>;
  externalImpactsService: {
    get(input: {
      corridors?: string[];
      date_from: string;
      date_to: string;
    }): Promise<
      SourceOutcome<
        Array<
          ExternalImpact & {
            corridor_matches: Array<{
              corridor_id: string;
              confidence: 'exact' | 'phrase';
              matched_aliases: string[];
            }>;
          }
        >
      >
    >;
  };
  lineHealthService: {
    get(input: { line_ids: string[] }): Promise<
      SourceOutcome<
        Array<{
          line_id: string;
          trip_count: number;
          observed_trip_count: number;
          coverage_ratio: number;
          average_delay_seconds: number;
          median_delay_seconds: number;
          p95_delay_seconds: number;
          max_delay_seconds: number;
          on_time_percentage: number;
          snapshot_at: string;
          warnings: SourceWarning[];
        }>
      >
    >;
  };
  passengerInformation(
    input: DraftPassengerInformationInput,
  ): PassengerInformationDraft;
  riskConfig: RiskConfig;
  serviceNoticesService: {
    get(input: {
      line_ids?: string[];
    }): Promise<SourceOutcome<ServiceNotice[]>>;
  };
}

export class ShiftBriefService {
  readonly #assessRisk: ShiftBriefServiceOptions['assessRisk'];
  readonly #clock: Clock;
  readonly #corridors: ReadonlyArray<Readonly<Corridor>>;
  readonly #externalImpactsService;
  readonly #lineHealthService;
  readonly #passengerInformation: ShiftBriefServiceOptions['passengerInformation'];
  readonly #riskConfig: RiskConfig;
  readonly #serviceNoticesService;

  constructor(options: ShiftBriefServiceOptions) {
    this.#assessRisk = (input, config) => options.assessRisk(input, config);
    this.#clock = options.clock;
    this.#corridors = options.corridors;
    this.#externalImpactsService = options.externalImpactsService;
    this.#lineHealthService = options.lineHealthService;
    this.#passengerInformation = (input) => options.passengerInformation(input);
    this.#riskConfig = options.riskConfig;
    this.#serviceNoticesService = options.serviceNoticesService;
  }

  async build(input: ShiftBriefBuildInput): Promise<SourceOutcome<ShiftBrief>> {
    const selectedCorridors = resolveShiftCorridors(
      this.#corridors,
      input.corridors,
    );
    const candidateLines = [
      ...new Set(selectedCorridors.flatMap((corridor) => corridor.line_ids)),
    ];
    const baselineAt = this.#clock.now().toISOString();
    const shiftWindow = buildShiftWindow(input.date);
    const [lineHealthOutcome, noticesOutcome, impactsOutcome] =
      await Promise.all([
        this.#lineHealthService.get({ line_ids: candidateLines }),
        this.#serviceNoticesService.get({ line_ids: candidateLines }),
        this.#externalImpactsService.get({
          corridors: selectedCorridors.map((corridor) => corridor.id),
          date_from: input.date,
          date_to: input.date,
        }),
      ]);

    const lineAssessments = candidateLines
      .map((lineId) => {
        const lineHealth = lineHealthOutcome.data.find(
          (entry) => entry.line_id === lineId,
        );
        const notices = noticesOutcome.data.filter((notice) =>
          notice.lines.includes(lineId),
        );
        const matchQuality = notices.length > 0 ? 'exact' : 'phrase';

        return this.#assessRisk(
          {
            target_type: 'line',
            target_id: lineId,
            ...(lineHealth === undefined ? {} : { line_health: lineHealth }),
            notices,
            impacts: impactsOutcome.data,
            source_statuses: collectSourceStatuses(
              lineHealthOutcome.sources,
              noticesOutcome.sources,
              impactsOutcome.sources,
            ),
            match_quality: matchQuality,
          },
          this.#riskConfig,
        );
      })
      .sort((left, right) => right.score - left.score);

    const corridorAssessments = selectedCorridors.map((corridor) => {
      const corridorLineAssessments = lineAssessments.filter((assessment) =>
        corridor.line_ids.includes(assessment.target_id),
      );
      const corridorScore = Math.max(
        0,
        ...corridorLineAssessments.map((assessment) => assessment.score),
      );

      return {
        target_type: 'corridor' as const,
        target_id: corridor.id,
        score: corridorScore,
        band: bandForBrief(corridorScore),
        contributions: corridorLineAssessments[0]?.contributions ?? [],
        confidence: corridorLineAssessments[0]?.confidence ?? 'low',
        warnings: corridorLineAssessments[0]?.warnings ?? [],
      };
    });

    const overlaps = lineAssessments
      .filter(
        (assessment) =>
          assessment.target_id === '10' ||
          assessment.contributions.some(
            (contribution) => contribution.kind === 'overlap',
          ),
      )
      .map((assessment) => ({
        line_id: assessment.target_id,
        impact_ids: impactsOutcome.data
          .filter((impact) => impact.category !== 'event')
          .map((impact) => impact.id),
        summary: `Line ${assessment.target_id} has realtime delays and VMZ roadworks overlap.`,
      }));

    const communications =
      input.include_comms_draft === true
        ? lineAssessments
            .filter(
              (assessment) =>
                assessment.band === 'high' || assessment.band === 'severe',
            )
            .map((assessment) =>
              this.#passengerInformation({
                line_ids: [assessment.target_id],
                issue_summary:
                  'Roadworks and diversions may affect the eastern corridor during the morning shift.',
                channel: 'app',
              }),
            )
        : [];

    return {
      data: {
        date: input.date,
        shift_window: shiftWindow,
        baseline_at: baselineAt,
        corridor_ids: selectedCorridors.map((corridor) => corridor.id),
        candidate_lines: candidateLines,
        line_assessments: lineAssessments,
        corridor_assessments: corridorAssessments,
        major_events: impactsOutcome.data.filter(
          (impact) => impact.category === 'event',
        ),
        overlaps,
        communications,
        operational_actions: lineAssessments
          .filter(
            (assessment) =>
              assessment.band === 'high' || assessment.band === 'severe',
          )
          .map(
            (assessment) =>
              `Prepare operational messaging for line ${assessment.target_id}.`,
          ),
      },
      sources: collectSourceStatuses(
        lineHealthOutcome.sources,
        noticesOutcome.sources,
        impactsOutcome.sources,
      ),
      warnings: [
        ...lineHealthOutcome.warnings,
        ...noticesOutcome.warnings,
        ...impactsOutcome.warnings,
      ],
    };
  }
}

function resolveShiftCorridors(
  allCorridors: ReadonlyArray<Readonly<Corridor>>,
  requestedIds: string[] | undefined,
): ReadonlyArray<Readonly<Corridor>> {
  if (requestedIds === undefined || requestedIds.length === 0) {
    return allCorridors;
  }

  return requestedIds.map((requestedId) => {
    const corridor = allCorridors.find(
      (candidate) => candidate.id === requestedId,
    );

    if (corridor === undefined) {
      throw new InputError(`Unknown corridor "${requestedId}"`);
    }

    return corridor;
  });
}

function buildShiftWindow(date: string): ShiftWindow {
  const [yearText, monthText, dayText] = date.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  return {
    start: new Date(
      new TZDate(year, month - 1, day, 6, 0, 0, 0, BERLIN_TIMEZONE).getTime(),
    ).toISOString(),
    end: new Date(
      new TZDate(year, month - 1, day, 10, 0, 0, 0, BERLIN_TIMEZONE).getTime(),
    ).toISOString(),
  };
}

function collectSourceStatuses(
  ...groups: Array<readonly SourceStatus[]>
): SourceStatus[] {
  return groups.flatMap((group) => group);
}

function bandForBrief(score: number): RiskAssessment['band'] {
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
