import { TZDate } from '@date-fns/tz';

const BERLIN_TIMEZONE = 'Europe/Berlin';
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;

export class InputError extends Error {
  readonly code = 'INPUT_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export interface TimeInterval {
  start: Date;
  end: Date;
}

function parseDateOnly(value: string): { year: number; month: number; day: number } {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new InputError(`Expected a YYYY-MM-DD date, received "${value}"`);
  }

  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InputError(`Invalid calendar date "${value}"`);
  }

  return { year, month, day };
}

function toUtcDate(value: TZDate): Date {
  return new Date(value.getTime());
}

export function parseBerlinRange(startDate: string, endDate: string): TimeInterval {
  const startParts = parseDateOnly(startDate);
  const endParts = parseDateOnly(endDate);
  const start = toUtcDate(
    new TZDate(
      startParts.year,
      startParts.month - 1,
      startParts.day,
      0,
      0,
      0,
      0,
      BERLIN_TIMEZONE,
    ),
  );
  const end = toUtcDate(
    new TZDate(
      endParts.year,
      endParts.month - 1,
      endParts.day,
      23,
      59,
      59,
      999,
      BERLIN_TIMEZONE,
    ),
  );

  if (start.getTime() > end.getTime()) {
    throw new InputError('Start date must not be after end date');
  }

  const startUtc = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const endUtc = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  const rangeDays = Math.floor((endUtc - startUtc) / 86_400_000) + 1;

  if (rangeDays > MAX_RANGE_DAYS) {
    throw new InputError('Date range must not exceed 31 days');
  }

  return { start, end };
}

export function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  if (a.start.getTime() > a.end.getTime() || b.start.getTime() > b.end.getTime()) {
    throw new InputError('Interval start must not be after interval end');
  }

  return a.start.getTime() <= b.end.getTime() && b.start.getTime() <= a.end.getTime();
}
