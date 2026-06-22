import gtfsRealtimeBindings from 'gtfs-realtime-bindings';

import type { SourceWarning } from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import type { Clock } from '../shared/clock.js';
import {
  SourceHttpClient,
  SourceHttpClientError,
  type BinaryFetchPolicy,
  type TextFetchPolicy,
} from './http-client.js';

const JSON_FETCH_POLICY: TextFetchPolicy = {
  expectedTypes: ['application/json', 'text/plain'],
  maxBytes: 25_000_000,
  timeoutMs: 10_000,
};

const PROTOBUF_FETCH_POLICY: BinaryFetchPolicy = {
  expectedTypes: [
    'application/octet-stream',
    'application/protobuf',
    'application/x-protobuf',
  ],
  maxBytes: 25_000_000,
  timeoutMs: 10_000,
};

export type ScheduleRelationship = 'scheduled' | 'skipped' | 'canceled';

export interface VbnRealtimeRecord {
  entity_id?: string;
  route_id: string;
  trip_id?: string;
  observed_at: string;
  delay_seconds?: number;
  has_usable_delay: boolean;
  schedule_relationship: ScheduleRelationship;
  update_count: number;
}

export interface VbnRealtimeSourceOptions {
  client: SourceHttpClient;
  jsonUrl: URL;
  protobufUrl?: URL;
  clock: Clock;
}

interface NormalizedFeed {
  header: {
    timestamp?: number | string;
  };
  entity: unknown[];
}

interface NormalizedEntity {
  id?: string;
  tripUpdate: {
    trip: {
      routeId: string;
      tripId?: string;
      scheduleRelationship?: string;
    };
    delay?: number | string;
    stopTimeUpdate?: NormalizedStopTimeUpdate[];
  };
}

interface NormalizedStopTimeUpdate {
  stopSequence?: number | string;
  scheduleRelationship?: string;
  arrival?: {
    delay?: number | string;
  };
  departure?: {
    delay?: number | string;
  };
}

export class VbnRealtimeParseError extends Error {
  constructor(
    readonly code:
      | 'JSON_PARSE_FAILED'
      | 'FEED_INVALID'
      | 'PROTOBUF_DECODE_FAILED',
    message: string,
    options: {
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'VbnRealtimeParseError';
  }
}

export class VbnRealtimeSource {
  readonly #client: SourceHttpClient;
  readonly #jsonUrl: URL;
  readonly #protobufUrl: URL | undefined;
  readonly #clock: Clock;

  constructor(options: VbnRealtimeSourceOptions) {
    this.#client = options.client;
    this.#jsonUrl = new URL(options.jsonUrl);
    this.#protobufUrl =
      options.protobufUrl === undefined
        ? undefined
        : new URL(options.protobufUrl);
    this.#clock = options.clock;
  }

  async fetch(): Promise<SourceOutcome<VbnRealtimeRecord[]>> {
    const fetchedAt = this.#clock.now().toISOString();

    if (this.#protobufUrl !== undefined) {
      try {
        const response = await this.#client.getBytes(
          this.#protobufUrl,
          PROTOBUF_FETCH_POLICY,
        );

        return decodeGtfsRealtime(response.body, fetchedAt);
      } catch (protobufError) {
        const outcome = await this.fetchJson(fetchedAt);

        return {
          ...outcome,
          warnings: [
            warning(
              'vbn_realtime',
              'PROTOBUF_SOURCE_FALLBACK',
              `Fell back to JSON after protobuf failure: ${describeError(protobufError)}`,
              {
                occurredAt: fetchedAt,
                retryable: isRetryableError(protobufError),
              },
            ),
            ...outcome.warnings,
          ],
        };
      }
    }

    return this.fetchJson(fetchedAt);
  }

  private async fetchJson(
    fetchedAt: string,
  ): Promise<SourceOutcome<VbnRealtimeRecord[]>> {
    const response = await this.#client.getText(
      this.#jsonUrl,
      JSON_FETCH_POLICY,
    );

    return parseVbnRealtimeJson(response.body, fetchedAt);
  }
}

export function parseVbnRealtimeJson(
  payload: string,
  fetchedAt: string,
): SourceOutcome<VbnRealtimeRecord[]> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload) as unknown;
  } catch (error) {
    throw new VbnRealtimeParseError(
      'JSON_PARSE_FAILED',
      'Invalid realtime JSON',
      {
        cause: error,
      },
    );
  }

  return parseNormalizedFeed(normalizeKeys(parsed), fetchedAt);
}

export function decodeGtfsRealtime(
  bytes: Uint8Array,
  fetchedAt: string,
): SourceOutcome<VbnRealtimeRecord[]> {
  let decoded: ReturnType<
    typeof gtfsRealtimeBindings.transit_realtime.FeedMessage.decode
  >;

  try {
    decoded = gtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  } catch (error) {
    throw new VbnRealtimeParseError(
      'PROTOBUF_DECODE_FAILED',
      'Invalid GTFS-Realtime protobuf payload',
      { cause: error },
    );
  }

  const plainObject =
    gtfsRealtimeBindings.transit_realtime.FeedMessage.toObject(decoded, {
      longs: Number,
      enums: String,
      defaults: false,
    });

  return parseNormalizedFeed(normalizeKeys(plainObject), fetchedAt);
}

function parseNormalizedFeed(
  rawFeed: unknown,
  fetchedAt: string,
): SourceOutcome<VbnRealtimeRecord[]> {
  const envelope = validateFeed(rawFeed);
  const observedAt = toObservedAt(envelope.header.timestamp, fetchedAt);
  const data: VbnRealtimeRecord[] = [];
  const warnings: SourceWarning[] = [];

  for (const rawEntity of envelope.entity) {
    const parsedEntity = validateEntity(rawEntity);

    if (!parsedEntity.ok) {
      warnings.push(
        warning('vbn_realtime', 'PARSER_ENTITY_INVALID', parsedEntity.message, {
          occurredAt: fetchedAt,
          retryable: false,
        }),
      );
      continue;
    }

    data.push(toRealtimeRecord(parsedEntity.entity, observedAt));
  }

  return {
    data,
    sources: [
      {
        source: 'vbn_realtime',
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

function validateFeed(rawFeed: unknown): NormalizedFeed {
  if (!isObject(rawFeed)) {
    throw new VbnRealtimeParseError(
      'FEED_INVALID',
      'Realtime feed must be an object',
    );
  }

  const header = rawFeed.header;
  const entity = rawFeed.entity;

  if (!isObject(header)) {
    throw new VbnRealtimeParseError(
      'FEED_INVALID',
      'Realtime feed header is missing',
    );
  }

  if (!Array.isArray(entity)) {
    throw new VbnRealtimeParseError(
      'FEED_INVALID',
      'Realtime feed entity list is missing',
    );
  }
  const timestamp = readOptionalScalar(header.timestamp);

  return {
    header: {
      ...(timestamp === undefined ? {} : { timestamp }),
    },
    entity,
  };
}

function validateEntity(
  rawEntity: unknown,
): { ok: true; entity: NormalizedEntity } | { ok: false; message: string } {
  if (!isObject(rawEntity)) {
    return { ok: false, message: 'Entity must be an object' };
  }

  const tripUpdate = rawEntity.tripUpdate;

  if (!isObject(tripUpdate)) {
    return { ok: false, message: 'Entity is missing tripUpdate' };
  }

  const trip = tripUpdate.trip;

  if (!isObject(trip)) {
    return { ok: false, message: 'Entity tripUpdate is missing trip details' };
  }

  const routeId = readOptionalString(trip.routeId);

  if (!routeId) {
    return { ok: false, message: 'Entity tripUpdate trip is missing routeId' };
  }

  const id = readOptionalString(rawEntity.id);
  const tripId = readOptionalString(trip.tripId);
  const tripRelationship = readOptionalString(trip.scheduleRelationship);
  const tripDelay = readOptionalScalar(tripUpdate.delay);
  const stopTimeUpdate = tripUpdate.stopTimeUpdate;

  return {
    ok: true,
    entity: {
      ...(id === undefined ? {} : { id }),
      tripUpdate: {
        trip: {
          routeId,
          ...(tripId === undefined ? {} : { tripId }),
          ...(tripRelationship === undefined
            ? {}
            : { scheduleRelationship: tripRelationship }),
        },
        ...(tripDelay === undefined ? {} : { delay: tripDelay }),
        ...(Array.isArray(stopTimeUpdate)
          ? {
              stopTimeUpdate: stopTimeUpdate.map((update) =>
                normalizeStopTimeUpdate(update),
              ),
            }
          : {}),
      },
    },
  };
}

function normalizeStopTimeUpdate(rawUpdate: unknown): NormalizedStopTimeUpdate {
  if (!isObject(rawUpdate)) {
    return {};
  }

  const arrival = isObject(rawUpdate.arrival) ? rawUpdate.arrival : undefined;
  const departure = isObject(rawUpdate.departure)
    ? rawUpdate.departure
    : undefined;
  const stopSequence = readOptionalScalar(rawUpdate.stopSequence);
  const scheduleRelationship = readOptionalString(
    rawUpdate.scheduleRelationship,
  );
  const arrivalDelay =
    arrival === undefined ? undefined : readOptionalScalar(arrival.delay);
  const departureDelay =
    departure === undefined ? undefined : readOptionalScalar(departure.delay);

  return {
    ...(stopSequence === undefined ? {} : { stopSequence }),
    ...(scheduleRelationship === undefined ? {} : { scheduleRelationship }),
    ...(arrivalDelay === undefined ? {} : { arrival: { delay: arrivalDelay } }),
    ...(departureDelay === undefined
      ? {}
      : { departure: { delay: departureDelay } }),
  };
}

function toRealtimeRecord(
  entity: NormalizedEntity,
  observedAt: string,
): VbnRealtimeRecord {
  const stopTimeUpdates = entity.tripUpdate.stopTimeUpdate ?? [];
  const stopTimeDelay = selectStopTimeDelay(stopTimeUpdates);
  const tripDelay = toInteger(entity.tripUpdate.delay);
  const delaySeconds = stopTimeDelay ?? tripDelay;

  return {
    ...(entity.id === undefined ? {} : { entity_id: entity.id }),
    route_id: entity.tripUpdate.trip.routeId,
    ...(entity.tripUpdate.trip.tripId === undefined
      ? {}
      : { trip_id: entity.tripUpdate.trip.tripId }),
    observed_at: observedAt,
    ...(delaySeconds === undefined ? {} : { delay_seconds: delaySeconds }),
    has_usable_delay: delaySeconds !== undefined,
    schedule_relationship: detectRelationship(entity.tripUpdate),
    update_count: stopTimeUpdates.length,
  };
}

function selectStopTimeDelay(
  stopTimeUpdates: readonly NormalizedStopTimeUpdate[],
): number | undefined {
  for (let index = stopTimeUpdates.length - 1; index >= 0; index -= 1) {
    const update = stopTimeUpdates[index];
    const departureDelay = toInteger(update?.departure?.delay);

    if (departureDelay !== undefined) {
      return departureDelay;
    }

    const arrivalDelay = toInteger(update?.arrival?.delay);

    if (arrivalDelay !== undefined) {
      return arrivalDelay;
    }
  }

  return undefined;
}

function detectRelationship(
  tripUpdate: NormalizedEntity['tripUpdate'],
): ScheduleRelationship {
  const tripRelationship = normalizeRelationship(
    tripUpdate.trip.scheduleRelationship,
  );

  if (tripRelationship === 'canceled') {
    return 'canceled';
  }

  if (tripRelationship === 'skipped') {
    return 'skipped';
  }

  for (const update of tripUpdate.stopTimeUpdate ?? []) {
    const relationship = normalizeRelationship(update.scheduleRelationship);

    if (relationship === 'canceled') {
      return 'canceled';
    }

    if (relationship === 'skipped') {
      return 'skipped';
    }
  }

  return 'scheduled';
}

function normalizeRelationship(
  value: string | undefined,
): ScheduleRelationship | undefined {
  const normalized = value?.toUpperCase();

  if (normalized === 'CANCELED') {
    return 'canceled';
  }

  if (normalized === 'SKIPPED') {
    return 'skipped';
  }

  if (normalized === 'SCHEDULED') {
    return 'scheduled';
  }

  return undefined;
}

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeKeys(entry));
  }

  if (!isObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key.length === 0 ? key : key.slice(0, 1).toLowerCase() + key.slice(1),
      normalizeKeys(nestedValue),
    ]),
  );
}

function toObservedAt(
  headerTimestamp: number | string | undefined,
  fetchedAt: string,
): string {
  const timestamp = toInteger(headerTimestamp);

  if (timestamp === undefined) {
    return fetchedAt;
  }

  return new Date(timestamp * 1000).toISOString();
}

function toInteger(value: number | string | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    return Number(value);
  }

  return undefined;
}

function readOptionalScalar(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }

  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRetryableError(error: unknown): boolean {
  return error instanceof SourceHttpClientError ? error.retryable : false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
