import { InputError } from '../shared/dates.js';

const MAX_ISSUE_SUMMARY_LENGTH = 2_000;
const APP_LIMIT = 240;
const STOP_LIMIT = 160;

export type PassengerInformationChannel = 'app' | 'web' | 'stop';

export interface DraftPassengerInformationInput {
  line_ids: string[];
  issue_summary: string;
  channel: PassengerInformationChannel;
}

export interface PassengerInformationWarning {
  code: 'SUMMARY_TRUNCATED' | 'MANUAL_EDIT_REQUIRED';
  message: string;
}

export interface PassengerInformationDraft {
  channel: PassengerInformationChannel;
  text: string;
  character_count: number;
  manual_edit_required: boolean;
  warnings: PassengerInformationWarning[];
}

export function draftPassengerInformation(
  input: DraftPassengerInformationInput,
): PassengerInformationDraft {
  const summary = sanitizeSummary(input.issue_summary);
  const lineIds = normalizeLineIds(input.line_ids);
  const lineLabel = formatLineLabel(lineIds);
  const impactSentence = `${lineLabel} may be affected.`;
  const cautionSummary = ensureTrailingPeriod(summary);

  switch (input.channel) {
    case 'app':
      return boundedDraft('app', APP_LIMIT, [
        impactSentence,
        cautionSummary,
        'Check the latest updates before travel.',
      ]);
    case 'stop':
      return boundedDraft('stop', STOP_LIMIT, [
        impactSentence,
        cautionSummary,
        'Check the app or website for updates.',
      ]);
    case 'web':
      return buildWebDraft(lineLabel, cautionSummary);
  }
}

function buildWebDraft(
  lineLabel: string,
  summary: string,
): PassengerInformationDraft {
  const heading = `# Service update for ${lineLabel}`;
  const firstParagraph = `${lineLabel} may be affected. ${summary}`;
  const secondParagraph = 'Check the latest updates before travel.';
  const text = [heading, firstParagraph, secondParagraph].join('\n\n');

  return {
    channel: 'web',
    text,
    character_count: text.length,
    manual_edit_required: false,
    warnings: [],
  };
}

function boundedDraft(
  channel: 'app' | 'stop',
  limit: number,
  sentences: [string, string, string],
): PassengerInformationDraft {
  const [impactSentence, summarySentence, advisorySentence] = sentences;
  const fullText = [impactSentence, summarySentence, advisorySentence].join(
    ' ',
  );

  if (fullText.length <= limit) {
    return {
      channel,
      text: fullText,
      character_count: fullText.length,
      manual_edit_required: false,
      warnings: [],
    };
  }

  const withoutAdvisory = [impactSentence, summarySentence].join(' ');

  if (withoutAdvisory.length <= limit) {
    return {
      channel,
      text: withoutAdvisory,
      character_count: withoutAdvisory.length,
      manual_edit_required: false,
      warnings: [
        {
          code: 'SUMMARY_TRUNCATED',
          message:
            'Optional travel advice was omitted to stay within the channel limit.',
        },
      ],
    };
  }

  const availableSummaryLength = limit - impactSentence.length - 1;
  const truncatedSummary = truncatePlainText(
    summarySentence,
    availableSummaryLength,
  );
  const text = [impactSentence, truncatedSummary].join(' ').slice(0, limit);

  return {
    channel,
    text,
    character_count: text.length,
    manual_edit_required: true,
    warnings: [
      {
        code: 'MANUAL_EDIT_REQUIRED',
        message: 'Essential content was compressed to fit the channel limit.',
      },
    ],
  };
}

function sanitizeSummary(value: string): string {
  const stripped = normalizeWhitespace(value.replace(/<[^>]+>/gu, ' '));

  if (stripped.length === 0) {
    throw new InputError('issue_summary must not be empty');
  }

  if (stripped.length > MAX_ISSUE_SUMMARY_LENGTH) {
    throw new InputError('issue_summary must be 2,000 characters or fewer');
  }

  return stripped;
}

function normalizeLineIds(lineIds: string[]): string[] {
  const unique = [
    ...new Set(
      lineIds.map((lineId) => normalizeWhitespace(lineId)).filter(Boolean),
    ),
  ];

  return unique.sort(compareLineIds);
}

function compareLineIds(left: string, right: string): number {
  const leftMatch = /^(\d+)(.*)$/u.exec(left);
  const rightMatch = /^(\d+)(.*)$/u.exec(right);

  if (leftMatch !== null && rightMatch !== null) {
    const numericDifference = Number(leftMatch[1]) - Number(rightMatch[1]);

    if (numericDifference !== 0) {
      return numericDifference;
    }

    return left.localeCompare(right, undefined, { numeric: true });
  }

  return left.localeCompare(right, undefined, { numeric: true });
}

function formatLineLabel(lineIds: string[]): string {
  if (lineIds.length === 0) {
    throw new InputError('line_ids must include at least one line');
  }

  const [firstLine] = lineIds;

  if (firstLine === undefined) {
    throw new InputError('line_ids must include at least one line');
  }

  return lineIds.length === 1
    ? `Line ${firstLine}`
    : `Lines ${lineIds.join(', ')}`;
}

function ensureTrailingPeriod(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

function truncatePlainText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  if (limit <= 1) {
    return value.slice(0, Math.max(limit, 0));
  }

  const slice = value.slice(0, limit - 1).trimEnd();

  return `${slice}…`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
