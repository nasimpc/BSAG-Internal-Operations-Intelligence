import type Database from 'better-sqlite3';
import { z } from 'zod';

import type {
  DelayObservation,
  ExternalImpact,
  Provenance,
  ServiceNotice,
  SourceId,
} from '../domain/models.js';
import type { DatabaseHandle } from './database.js';

const DAY_IN_MILLISECONDS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;

const sourceIdSchema = z.enum([
  'vbn_realtime',
  'vbn_notices',
  'bsag',
  'vmz_rss',
  'vmz_web',
  'vmz_pdf',
  'bremen_events',
]);

const provenanceSchema = z.object({
  source: sourceIdSchema,
  sourceUrl: z.string().min(1),
  fetchedAt: z.string().min(1),
  publishedAt: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional(),
});

const delayObservationSchema = z.object({
  line_id: z.string().min(1),
  entity_id: z.string().min(1).optional(),
  direction: z.string().min(1).optional(),
  stop_name: z.string().min(1).optional(),
  scheduled_at: z.string().min(1).optional(),
  observed_at: z.string().min(1),
  delay_seconds: z.number().int(),
  has_usable_delay: z.boolean().optional(),
  schedule_relationship: z
    .enum(['scheduled', 'skipped', 'canceled'])
    .optional(),
  trip_id: z.string().min(1).optional(),
  stop_sequence: z.number().int().optional(),
  update_count: z.number().int().min(0).optional(),
  provenance: provenanceSchema,
});

const serviceNoticeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().min(1).optional(),
  lines: z.array(z.string().min(1)),
  stop_names: z.array(z.string().min(1)),
  valid_from: z.string().min(1).optional(),
  valid_to: z.string().min(1).optional(),
  severity: z.enum(['info', 'warning', 'critical']),
  provenance: provenanceSchema,
});

const externalImpactSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().min(1).optional(),
  corridor_ids: z.array(z.string().min(1)),
  starts_at: z.string().min(1).optional(),
  ends_at: z.string().min(1).optional(),
  category: z.enum(['roadworks', 'event', 'incident', 'other']),
  severity: z.enum(['low', 'moderate', 'high', 'severe']),
  provenance: provenanceSchema,
});

const sourceStateSchema = z.object({
  source: sourceIdSchema,
  fetchedAt: z.string().min(1),
  contentHash: z.string().min(1).optional(),
});

type SourceStateRecord = z.infer<typeof sourceStateSchema>;

interface SnapshotRow {
  snapshotId: number;
  snapshotAt: string;
}

interface LineIdRow {
  lineId: string;
}

interface DelayObservationRow {
  lineId: string;
  entityId: string | null;
  direction: string | null;
  stopName: string | null;
  scheduledAt: string | null;
  observedAt: string;
  delaySeconds: number;
  hasUsableDelay: number;
  scheduleRelationship: string | null;
  tripId: string | null;
  stopSequence: number | null;
  updateCount: number;
  provenanceJson: string;
}

interface ServiceNoticeRow {
  id: string;
  title: string;
  summary: string;
  details: string | null;
  linesJson: string;
  stopNamesJson: string;
  validFrom: string | null;
  validTo: string | null;
  severity: ServiceNotice['severity'];
  provenanceJson: string;
}

interface ExternalImpactRow {
  id: string;
  title: string;
  summary: string;
  details: string | null;
  corridorIdsJson: string;
  startsAt: string | null;
  endsAt: string | null;
  category: ExternalImpact['category'];
  severity: ExternalImpact['severity'];
  provenanceJson: string;
}

interface SourceStateRow {
  source: SourceId;
  fetchedAt: string;
  contentHash: string | null;
}

export interface HistoricalSnapshot {
  snapshotAt: string;
  observations: DelayObservation[];
}

export interface RealtimeSnapshotLineIds {
  snapshotAt: string;
  lineIds: string[];
}

export interface WriteSnapshotOptions {
  cleanupAsOf?: string;
  fetchedAt?: string;
  retentionDays?: number;
}

export interface SourceStateRepository {
  get(source: SourceId): SourceStateRecord | undefined;
  upsert(record: SourceStateRecord): void;
}

export interface RealtimeRepository {
  cleanupOldSnapshots(retentionDays: number, asOf: string): number;
  findSnapshotLineIdsAtOrBefore(
    source: SourceId,
    atTime: string,
    maxAgeSeconds: number,
  ): RealtimeSnapshotLineIds | undefined;
  findSnapshotAtOrBefore(
    lineId: string,
    atTime: string,
    maxAgeSeconds: number,
  ): HistoricalSnapshot | undefined;
  writeSnapshot(
    source: SourceId,
    snapshotAt: string,
    observations: DelayObservation[],
    options?: WriteSnapshotOptions,
  ): void;
}

export interface ServiceNoticeRepository {
  listAll(): ServiceNotice[];
  replaceForSource(
    source: SourceId,
    notices: ServiceNotice[],
    fetchedAt?: string,
  ): void;
}

export interface ExternalImpactRepository {
  listAll(): ExternalImpact[];
  replaceForSource(
    source: SourceId,
    impacts: ExternalImpact[],
    fetchedAt?: string,
  ): void;
}

export interface DatabaseRepositories {
  externalImpacts: ExternalImpactRepository;
  realtime: RealtimeRepository;
  serviceNotices: ServiceNoticeRepository;
  sourceState: SourceStateRepository;
}

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageValidationError';
  }
}

export function createRepositories(
  handle: DatabaseHandle,
): DatabaseRepositories {
  const sourceState = new SqliteSourceStateRepository(handle.connection);

  return {
    sourceState,
    realtime: new SqliteRealtimeRepository(handle.connection, sourceState),
    serviceNotices: new SqliteServiceNoticeRepository(
      handle.connection,
      sourceState,
    ),
    externalImpacts: new SqliteExternalImpactRepository(
      handle.connection,
      sourceState,
    ),
  };
}

class SqliteSourceStateRepository implements SourceStateRepository {
  readonly #getStatement;
  readonly #upsertStatement;

  constructor(database: Database.Database) {
    this.#getStatement = database.prepare<[SourceId], SourceStateRow>(
      `SELECT source, fetched_at AS fetchedAt, content_hash AS contentHash
         FROM source_state
        WHERE source = ?`,
    );
    this.#upsertStatement = database.prepare<[SourceId, string, string | null]>(
      `INSERT INTO source_state (source, fetched_at, content_hash)
       VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         fetched_at = excluded.fetched_at,
         content_hash = excluded.content_hash`,
    );
  }

  get(source: SourceId): SourceStateRecord | undefined {
    const row = this.#getStatement.get(source);

    if (!row) {
      return undefined;
    }

    return sourceStateSchema.parse({
      source: row.source,
      fetchedAt: row.fetchedAt,
      ...(row.contentHash === null ? {} : { contentHash: row.contentHash }),
    });
  }

  upsert(record: SourceStateRecord): void {
    const parsed = sourceStateSchema.parse(record);

    this.#upsertStatement.run(
      parsed.source,
      parsed.fetchedAt,
      parsed.contentHash ?? null,
    );
  }
}

class SqliteRealtimeRepository implements RealtimeRepository {
  readonly #cleanupStatement;
  readonly #deleteObservationsForSnapshotStatement;
  readonly #findObservationsForSnapshotStatement;
  readonly #findLineIdsForSnapshotStatement;
  readonly #findSnapshotForSourceStatement;
  readonly #findSnapshotForLineStatement;
  readonly #findSnapshotIdStatement;
  readonly #insertObservationStatement;
  readonly #upsertSnapshotStatement;
  readonly #writeSnapshotTransaction;

  constructor(
    database: Database.Database,
    private readonly sourceStateRepository: SourceStateRepository,
  ) {
    this.#upsertSnapshotStatement = database.prepare<
      [SourceId, string, string]
    >(
      `INSERT INTO realtime_snapshots (source, snapshot_at, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(source, snapshot_at) DO UPDATE SET
         fetched_at = excluded.fetched_at`,
    );
    this.#findSnapshotIdStatement = database.prepare<
      [SourceId, string],
      { id: number }
    >(
      `SELECT id
         FROM realtime_snapshots
        WHERE source = ? AND snapshot_at = ?`,
    );
    this.#deleteObservationsForSnapshotStatement = database.prepare<[number]>(
      'DELETE FROM delay_observations WHERE snapshot_id = ?',
    );
    this.#insertObservationStatement = database.prepare<
      [
        number,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        number,
        number,
        string | null,
        string | null,
        number | null,
        number,
        string,
      ]
    >(
      `INSERT INTO delay_observations (
         snapshot_id,
         line_id,
         entity_id,
         direction,
         stop_name,
         scheduled_at,
         observed_at,
         delay_seconds,
         has_usable_delay,
         schedule_relationship,
         trip_id,
         stop_sequence,
         update_count,
         provenance_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#findSnapshotForLineStatement = database.prepare<
      [string, string],
      SnapshotRow
    >(
      `SELECT s.id AS snapshotId, s.snapshot_at AS snapshotAt
         FROM realtime_snapshots AS s
         JOIN delay_observations AS o ON o.snapshot_id = s.id
        WHERE o.line_id = ? AND s.snapshot_at <= ?
        GROUP BY s.id, s.snapshot_at
        ORDER BY s.snapshot_at DESC
        LIMIT 1`,
    );
    this.#findSnapshotForSourceStatement = database.prepare<
      [SourceId, string],
      SnapshotRow
    >(
      `SELECT id AS snapshotId, snapshot_at AS snapshotAt
         FROM realtime_snapshots
        WHERE source = ? AND snapshot_at <= ?
        ORDER BY snapshot_at DESC
        LIMIT 1`,
    );
    this.#findLineIdsForSnapshotStatement = database.prepare<
      [number],
      LineIdRow
    >(
      `SELECT DISTINCT line_id AS lineId
         FROM delay_observations
        WHERE snapshot_id = ?
        ORDER BY line_id ASC`,
    );
    this.#findObservationsForSnapshotStatement = database.prepare<
      [number, string],
      DelayObservationRow
    >(
      `SELECT
         line_id AS lineId,
         entity_id AS entityId,
         direction,
         stop_name AS stopName,
         scheduled_at AS scheduledAt,
         observed_at AS observedAt,
         delay_seconds AS delaySeconds,
         has_usable_delay AS hasUsableDelay,
         schedule_relationship AS scheduleRelationship,
         trip_id AS tripId,
         stop_sequence AS stopSequence,
         update_count AS updateCount,
         provenance_json AS provenanceJson
       FROM delay_observations
       WHERE snapshot_id = ? AND line_id = ?
       ORDER BY observed_at ASC, trip_id ASC, stop_sequence ASC`,
    );
    this.#cleanupStatement = database.prepare<[string]>(
      'DELETE FROM realtime_snapshots WHERE snapshot_at < ?',
    );
    this.#writeSnapshotTransaction = database.transaction(
      (
        source: SourceId,
        snapshotAt: string,
        fetchedAt: string,
        cleanupAsOf: string,
        retentionDays: number,
        observations: DelayObservation[],
      ) => {
        this.#upsertSnapshotStatement.run(source, snapshotAt, fetchedAt);
        const snapshotRow = this.#findSnapshotIdStatement.get(
          source,
          snapshotAt,
        );

        if (!snapshotRow) {
          throw new StorageValidationError(
            `Failed to locate snapshot row for ${source} at ${snapshotAt}`,
          );
        }

        this.#deleteObservationsForSnapshotStatement.run(snapshotRow.id);

        for (const observation of observations) {
          this.#insertObservationStatement.run(
            snapshotRow.id,
            observation.line_id,
            observation.entity_id ?? null,
            observation.direction ?? null,
            observation.stop_name ?? null,
            observation.scheduled_at ?? null,
            observation.observed_at,
            observation.delay_seconds,
            (observation.has_usable_delay ?? true) ? 1 : 0,
            observation.schedule_relationship ?? null,
            observation.trip_id ?? null,
            observation.stop_sequence ?? null,
            observation.update_count ?? 1,
            serializeJson(provenanceSchema, observation.provenance),
          );
        }

        this.cleanupOldSnapshots(retentionDays, cleanupAsOf);
        this.sourceStateRepository.upsert({ source, fetchedAt });
      },
    );
  }

  cleanupOldSnapshots(retentionDays: number, asOf: string): number {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new StorageValidationError(
        `retentionDays must be a positive integer, received ${String(retentionDays)}`,
      );
    }

    const cutoff = new Date(
      parseTimestamp(asOf) - retentionDays * DAY_IN_MILLISECONDS,
    ).toISOString();
    const result = this.#cleanupStatement.run(cutoff);

    return result.changes;
  }

  findSnapshotAtOrBefore(
    lineId: string,
    atTime: string,
    maxAgeSeconds: number,
  ): HistoricalSnapshot | undefined {
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
      throw new StorageValidationError(
        `maxAgeSeconds must be zero or greater, received ${String(maxAgeSeconds)}`,
      );
    }

    const snapshot = this.#findSnapshotForLineStatement.get(lineId, atTime);

    if (!snapshot) {
      return undefined;
    }

    const ageSeconds = Math.floor(
      (parseTimestamp(atTime) - parseTimestamp(snapshot.snapshotAt)) / 1000,
    );

    if (ageSeconds > maxAgeSeconds) {
      return undefined;
    }

    return {
      snapshotAt: snapshot.snapshotAt,
      observations: this.#findObservationsForSnapshotStatement
        .all(snapshot.snapshotId, lineId)
        .map((row) => toDelayObservation(row)),
    };
  }

  findSnapshotLineIdsAtOrBefore(
    source: SourceId,
    atTime: string,
    maxAgeSeconds: number,
  ): RealtimeSnapshotLineIds | undefined {
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
      throw new StorageValidationError(
        `maxAgeSeconds must be zero or greater, received ${String(maxAgeSeconds)}`,
      );
    }

    const snapshot = this.#findSnapshotForSourceStatement.get(source, atTime);

    if (!snapshot) {
      return undefined;
    }

    const ageSeconds = Math.floor(
      (parseTimestamp(atTime) - parseTimestamp(snapshot.snapshotAt)) / 1000,
    );

    if (ageSeconds > maxAgeSeconds) {
      return undefined;
    }

    return {
      snapshotAt: snapshot.snapshotAt,
      lineIds: this.#findLineIdsForSnapshotStatement
        .all(snapshot.snapshotId)
        .map((row) => row.lineId),
    };
  }

  writeSnapshot(
    source: SourceId,
    snapshotAt: string,
    observations: DelayObservation[],
    options: WriteSnapshotOptions = {},
  ): void {
    const parsedObservations = observations.map((observation) => {
      const parsed = delayObservationSchema.parse(observation);

      if (parsed.provenance.source !== source) {
        throw new StorageValidationError(
          `Delay observation provenance source ${parsed.provenance.source} does not match ${source}`,
        );
      }

      return normalizeDelayObservation(parsed);
    });
    const fetchedAt = options.fetchedAt ?? snapshotAt;
    const cleanupAsOf = options.cleanupAsOf ?? fetchedAt;
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

    parseTimestamp(snapshotAt);
    parseTimestamp(fetchedAt);
    parseTimestamp(cleanupAsOf);

    this.#writeSnapshotTransaction(
      source,
      snapshotAt,
      fetchedAt,
      cleanupAsOf,
      retentionDays,
      parsedObservations,
    );
  }
}

class SqliteServiceNoticeRepository implements ServiceNoticeRepository {
  readonly #deleteForSourceStatement;
  readonly #listAllStatement;
  readonly #replaceForSourceTransaction;
  readonly #upsertStatement;

  constructor(
    database: Database.Database,
    private readonly sourceStateRepository: SourceStateRepository,
  ) {
    this.#deleteForSourceStatement = database.prepare<[SourceId]>(
      'DELETE FROM service_notices WHERE source = ?',
    );
    this.#upsertStatement = database.prepare<
      [
        SourceId,
        string,
        string,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
        ServiceNotice['severity'],
        string,
        string | null,
        string,
      ]
    >(
      `INSERT INTO service_notices (
         source,
         id,
         title,
         summary,
         details,
         lines_json,
         stop_names_json,
         valid_from,
         valid_to,
         severity,
         provenance_json,
         content_hash,
         fetched_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, id) DO UPDATE SET
         title = excluded.title,
         summary = excluded.summary,
         details = excluded.details,
         lines_json = excluded.lines_json,
         stop_names_json = excluded.stop_names_json,
         valid_from = excluded.valid_from,
         valid_to = excluded.valid_to,
         severity = excluded.severity,
         provenance_json = excluded.provenance_json,
         content_hash = excluded.content_hash,
         fetched_at = excluded.fetched_at`,
    );
    this.#listAllStatement = database.prepare<[], ServiceNoticeRow>(
      `SELECT
         id,
         title,
         summary,
         details,
         lines_json AS linesJson,
         stop_names_json AS stopNamesJson,
         valid_from AS validFrom,
         valid_to AS validTo,
         severity,
         provenance_json AS provenanceJson
       FROM service_notices
       ORDER BY source ASC, fetched_at DESC, id ASC`,
    );
    this.#replaceForSourceTransaction = database.transaction(
      (source: SourceId, notices: ServiceNotice[], fetchedAt: string) => {
        this.#deleteForSourceStatement.run(source);

        for (const notice of notices) {
          this.#upsertStatement.run(
            source,
            notice.id,
            notice.title,
            notice.summary,
            notice.details ?? null,
            serializeJson(z.array(z.string().min(1)), notice.lines),
            serializeJson(z.array(z.string().min(1)), notice.stop_names),
            notice.valid_from ?? null,
            notice.valid_to ?? null,
            notice.severity,
            serializeJson(provenanceSchema, notice.provenance),
            notice.provenance.contentHash ?? null,
            notice.provenance.fetchedAt,
          );
        }

        this.sourceStateRepository.upsert({ source, fetchedAt });
      },
    );
  }

  listAll(): ServiceNotice[] {
    return this.#listAllStatement.all().map((row) => toServiceNotice(row));
  }

  replaceForSource(
    source: SourceId,
    notices: ServiceNotice[],
    fetchedAt?: string,
  ): void {
    const parsedNotices = notices.map((notice) => {
      const parsed = serviceNoticeSchema.parse(notice);

      if (parsed.provenance.source !== source) {
        throw new StorageValidationError(
          `Service notice provenance source ${parsed.provenance.source} does not match ${source}`,
        );
      }

      return normalizeServiceNotice(parsed);
    });
    const effectiveFetchedAt = fetchedAt ?? inferBatchFetchedAt(parsedNotices);

    if (!effectiveFetchedAt) {
      throw new StorageValidationError(
        `replaceForSource requires fetchedAt when no service notices are provided for ${source}`,
      );
    }

    parseTimestamp(effectiveFetchedAt);
    this.#replaceForSourceTransaction(
      source,
      parsedNotices,
      effectiveFetchedAt,
    );
  }
}

class SqliteExternalImpactRepository implements ExternalImpactRepository {
  readonly #deleteForSourceStatement;
  readonly #listAllStatement;
  readonly #replaceForSourceTransaction;
  readonly #upsertStatement;

  constructor(
    database: Database.Database,
    private readonly sourceStateRepository: SourceStateRepository,
  ) {
    this.#deleteForSourceStatement = database.prepare<[SourceId]>(
      'DELETE FROM external_impacts WHERE source = ?',
    );
    this.#upsertStatement = database.prepare<
      [
        SourceId,
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        ExternalImpact['category'],
        ExternalImpact['severity'],
        string,
        string | null,
        string,
      ]
    >(
      `INSERT INTO external_impacts (
         source,
         id,
         title,
         summary,
         details,
         corridor_ids_json,
         starts_at,
         ends_at,
         category,
         severity,
         provenance_json,
         content_hash,
         fetched_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, id) DO UPDATE SET
         title = excluded.title,
         summary = excluded.summary,
         details = excluded.details,
         corridor_ids_json = excluded.corridor_ids_json,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         category = excluded.category,
         severity = excluded.severity,
         provenance_json = excluded.provenance_json,
         content_hash = excluded.content_hash,
         fetched_at = excluded.fetched_at`,
    );
    this.#listAllStatement = database.prepare<[], ExternalImpactRow>(
      `SELECT
         id,
         title,
         summary,
         details,
         corridor_ids_json AS corridorIdsJson,
         starts_at AS startsAt,
         ends_at AS endsAt,
         category,
         severity,
         provenance_json AS provenanceJson
       FROM external_impacts
       ORDER BY source ASC, fetched_at DESC, id ASC`,
    );
    this.#replaceForSourceTransaction = database.transaction(
      (source: SourceId, impacts: ExternalImpact[], fetchedAt: string) => {
        this.#deleteForSourceStatement.run(source);

        for (const impact of impacts) {
          this.#upsertStatement.run(
            source,
            impact.id,
            impact.title,
            impact.summary,
            impact.details ?? null,
            serializeJson(z.array(z.string().min(1)), impact.corridor_ids),
            impact.starts_at ?? null,
            impact.ends_at ?? null,
            impact.category,
            impact.severity,
            serializeJson(provenanceSchema, impact.provenance),
            impact.provenance.contentHash ?? null,
            impact.provenance.fetchedAt,
          );
        }

        this.sourceStateRepository.upsert({ source, fetchedAt });
      },
    );
  }

  listAll(): ExternalImpact[] {
    return this.#listAllStatement.all().map((row) => toExternalImpact(row));
  }

  replaceForSource(
    source: SourceId,
    impacts: ExternalImpact[],
    fetchedAt?: string,
  ): void {
    const parsedImpacts = impacts.map((impact) => {
      const parsed = externalImpactSchema.parse(impact);

      if (parsed.provenance.source !== source) {
        throw new StorageValidationError(
          `External impact provenance source ${parsed.provenance.source} does not match ${source}`,
        );
      }

      return normalizeExternalImpact(parsed);
    });
    const effectiveFetchedAt = fetchedAt ?? inferBatchFetchedAt(parsedImpacts);

    if (!effectiveFetchedAt) {
      throw new StorageValidationError(
        `replaceForSource requires fetchedAt when no external impacts are provided for ${source}`,
      );
    }

    parseTimestamp(effectiveFetchedAt);
    this.#replaceForSourceTransaction(
      source,
      parsedImpacts,
      effectiveFetchedAt,
    );
  }
}

function inferBatchFetchedAt(
  records: Array<{ provenance: { fetchedAt: string } }>,
): string | undefined {
  const fetchedAtValues = records.map((record) => record.provenance.fetchedAt);

  if (fetchedAtValues.length === 0) {
    return undefined;
  }

  return fetchedAtValues.reduce((latest, current) =>
    parseTimestamp(current) > parseTimestamp(latest) ? current : latest,
  );
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    throw new StorageValidationError(`Invalid timestamp: ${value}`);
  }

  return parsed;
}

function serializeJson<T>(schema: z.ZodType<T>, value: T): string {
  return JSON.stringify(schema.parse(value));
}

function parseJson<T>(schema: z.ZodType<T>, value: string): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new StorageValidationError(
      `Failed to parse persisted JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return schema.parse(parsed);
}

function normalizeProvenance(
  value: z.infer<typeof provenanceSchema>,
): Provenance {
  return {
    source: value.source,
    sourceUrl: value.sourceUrl,
    fetchedAt: value.fetchedAt,
    ...(value.publishedAt === undefined
      ? {}
      : { publishedAt: value.publishedAt }),
    ...(value.contentHash === undefined
      ? {}
      : { contentHash: value.contentHash }),
  };
}

function normalizeDelayObservation(
  value: z.infer<typeof delayObservationSchema>,
): DelayObservation {
  return {
    line_id: value.line_id,
    ...(value.entity_id === undefined ? {} : { entity_id: value.entity_id }),
    ...(value.direction === undefined ? {} : { direction: value.direction }),
    ...(value.stop_name === undefined ? {} : { stop_name: value.stop_name }),
    ...(value.scheduled_at === undefined
      ? {}
      : { scheduled_at: value.scheduled_at }),
    observed_at: value.observed_at,
    delay_seconds: value.delay_seconds,
    ...(value.has_usable_delay === undefined
      ? {}
      : { has_usable_delay: value.has_usable_delay }),
    ...(value.schedule_relationship === undefined
      ? {}
      : { schedule_relationship: value.schedule_relationship }),
    ...(value.trip_id === undefined ? {} : { trip_id: value.trip_id }),
    ...(value.stop_sequence === undefined
      ? {}
      : { stop_sequence: value.stop_sequence }),
    ...(value.update_count === undefined
      ? {}
      : { update_count: value.update_count }),
    provenance: normalizeProvenance(value.provenance),
  };
}

function normalizeServiceNotice(
  value: z.infer<typeof serviceNoticeSchema>,
): ServiceNotice {
  return {
    id: value.id,
    title: value.title,
    summary: value.summary,
    ...(value.details === undefined ? {} : { details: value.details }),
    lines: value.lines,
    stop_names: value.stop_names,
    ...(value.valid_from === undefined ? {} : { valid_from: value.valid_from }),
    ...(value.valid_to === undefined ? {} : { valid_to: value.valid_to }),
    severity: value.severity,
    provenance: normalizeProvenance(value.provenance),
  };
}

function normalizeExternalImpact(
  value: z.infer<typeof externalImpactSchema>,
): ExternalImpact {
  return {
    id: value.id,
    title: value.title,
    summary: value.summary,
    ...(value.details === undefined ? {} : { details: value.details }),
    corridor_ids: value.corridor_ids,
    ...(value.starts_at === undefined ? {} : { starts_at: value.starts_at }),
    ...(value.ends_at === undefined ? {} : { ends_at: value.ends_at }),
    category: value.category,
    severity: value.severity,
    provenance: normalizeProvenance(value.provenance),
  };
}

function toDelayObservation(row: DelayObservationRow): DelayObservation {
  return normalizeDelayObservation(
    delayObservationSchema.parse({
      line_id: row.lineId,
      ...(row.entityId === null ? {} : { entity_id: row.entityId }),
      ...(row.direction === null ? {} : { direction: row.direction }),
      ...(row.stopName === null ? {} : { stop_name: row.stopName }),
      ...(row.scheduledAt === null ? {} : { scheduled_at: row.scheduledAt }),
      observed_at: row.observedAt,
      delay_seconds: row.delaySeconds,
      has_usable_delay: row.hasUsableDelay === 1,
      ...(row.scheduleRelationship === null
        ? {}
        : { schedule_relationship: row.scheduleRelationship }),
      ...(row.tripId === null ? {} : { trip_id: row.tripId }),
      ...(row.stopSequence === null ? {} : { stop_sequence: row.stopSequence }),
      update_count: row.updateCount,
      provenance: parseJson(provenanceSchema, row.provenanceJson),
    }),
  );
}

function toServiceNotice(row: ServiceNoticeRow): ServiceNotice {
  return normalizeServiceNotice(
    serviceNoticeSchema.parse({
      id: row.id,
      title: row.title,
      summary: row.summary,
      ...(row.details === null ? {} : { details: row.details }),
      lines: parseJson(z.array(z.string().min(1)), row.linesJson),
      stop_names: parseJson(z.array(z.string().min(1)), row.stopNamesJson),
      ...(row.validFrom === null ? {} : { valid_from: row.validFrom }),
      ...(row.validTo === null ? {} : { valid_to: row.validTo }),
      severity: row.severity,
      provenance: parseJson(provenanceSchema, row.provenanceJson),
    }),
  );
}

function toExternalImpact(row: ExternalImpactRow): ExternalImpact {
  return normalizeExternalImpact(
    externalImpactSchema.parse({
      id: row.id,
      title: row.title,
      summary: row.summary,
      ...(row.details === null ? {} : { details: row.details }),
      corridor_ids: parseJson(z.array(z.string().min(1)), row.corridorIdsJson),
      ...(row.startsAt === null ? {} : { starts_at: row.startsAt }),
      ...(row.endsAt === null ? {} : { ends_at: row.endsAt }),
      category: row.category,
      severity: row.severity,
      provenance: parseJson(provenanceSchema, row.provenanceJson),
    }),
  );
}
