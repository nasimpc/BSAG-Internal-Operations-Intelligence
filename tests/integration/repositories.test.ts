import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  DelayObservation,
  ExternalImpact,
  ServiceNotice,
} from '../../src/domain/models.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type DatabaseRepositories,
} from '../../src/storage/repositories.js';

interface Harness {
  dir: string;
  repositories: DatabaseRepositories;
  handle: ReturnType<typeof openDatabase>;
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'bsag-repositories-'));
  const handle = openDatabase(join(dir, 'storage.sqlite'));

  return {
    dir,
    handle,
    repositories: createRepositories(handle),
  };
}

function destroyHarness(harness: Harness): void {
  harness.handle.close();
  rmSync(harness.dir, { recursive: true, force: true });
}

function buildDelayObservation(
  lineId: string,
  observedAt: string,
  delaySeconds: number,
): DelayObservation {
  return {
    line_id: lineId,
    observed_at: observedAt,
    delay_seconds: delaySeconds,
    trip_id: `${lineId}-${observedAt}`,
    provenance: {
      source: 'vbn_realtime',
      sourceUrl: 'https://example.test/vbn-realtime',
      fetchedAt: observedAt,
      contentHash: `${lineId}-${String(delaySeconds)}`,
    },
  };
}

function buildNotice(overrides: Partial<ServiceNotice> = {}): ServiceNotice {
  return {
    id: 'notice-1',
    title: 'Line 1 diversion',
    summary: 'Line 1 diverts via test stop',
    lines: ['1', '1E'],
    stop_names: ['Test Stop'],
    severity: 'warning',
    provenance: {
      source: 'bsag',
      sourceUrl: 'https://example.test/bsag/notices/notice-1',
      fetchedAt: '2026-06-20T05:00:00Z',
      contentHash: 'notice-hash-1',
    },
    ...overrides,
  };
}

function buildImpact(overrides: Partial<ExternalImpact> = {}): ExternalImpact {
  return {
    id: 'impact-1',
    title: 'Roadworks east corridor',
    summary: 'Roadworks affect east corridor',
    corridor_ids: ['east'],
    category: 'roadworks',
    severity: 'moderate',
    provenance: {
      source: 'vmz_web',
      sourceUrl: 'https://example.test/vmz/impact-1',
      fetchedAt: '2026-06-20T05:00:00Z',
      contentHash: 'impact-hash-1',
    },
    ...overrides,
  };
}

describe('storage repositories', () => {
  it('upserts source state for the same source', () => {
    const harness = createHarness();

    try {
      harness.repositories.sourceState.upsert({
        source: 'bsag',
        fetchedAt: '2026-06-20T05:00:00Z',
        contentHash: 'state-hash-1',
      });
      harness.repositories.sourceState.upsert({
        source: 'bsag',
        fetchedAt: '2026-06-20T06:00:00Z',
        contentHash: 'state-hash-2',
      });

      expect(harness.repositories.sourceState.get('bsag')).toEqual({
        source: 'bsag',
        fetchedAt: '2026-06-20T06:00:00Z',
        contentHash: 'state-hash-2',
      });

      const rows = harness.handle.connection
        .prepare<
          [string],
          { count: number }
        >('SELECT COUNT(*) AS count FROM source_state WHERE source = ?')
        .all('bsag');

      expect(rows[0]?.count).toBe(1);
    } finally {
      destroyHarness(harness);
    }
  });

  it('deduplicates service notices by stable id and content hash', () => {
    const harness = createHarness();
    const notice = buildNotice();
    const updatedNotice = buildNotice({
      summary: 'Line 1 diverts via updated stop',
      provenance: {
        ...notice.provenance,
        fetchedAt: '2026-06-20T06:00:00Z',
        contentHash: 'notice-hash-2',
      },
    });

    try {
      harness.repositories.serviceNotices.replaceForSource('bsag', [
        notice,
        notice,
      ]);

      expect(harness.repositories.serviceNotices.listAll()).toEqual([notice]);

      const rawRow = harness.handle.connection
        .prepare<
          [],
          { linesJson: string; provenanceJson: string }
        >('SELECT lines_json AS linesJson, provenance_json AS provenanceJson FROM service_notices')
        .get();

      expect(rawRow).toBeDefined();
      expect(JSON.parse(rawRow ? rawRow.linesJson : '[]')).toEqual(['1', '1E']);
      expect(JSON.parse(rawRow ? rawRow.provenanceJson : '{}')).toMatchObject({
        source: 'bsag',
        contentHash: 'notice-hash-1',
      });

      harness.repositories.serviceNotices.replaceForSource('bsag', [
        updatedNotice,
      ]);

      const noticeRows = harness.handle.connection
        .prepare<
          [],
          { count: number }
        >('SELECT COUNT(*) AS count FROM service_notices')
        .all();

      expect(noticeRows[0]?.count).toBe(1);
      expect(harness.repositories.serviceNotices.listAll()).toEqual([
        updatedNotice,
      ]);
    } finally {
      destroyHarness(harness);
    }
  });

  it('deduplicates external impacts by stable id and content hash', () => {
    const harness = createHarness();
    const impact = buildImpact();
    const updatedImpact = buildImpact({
      summary: 'Updated roadworks affect east corridor',
      provenance: {
        ...impact.provenance,
        fetchedAt: '2026-06-20T06:00:00Z',
        contentHash: 'impact-hash-2',
      },
    });

    try {
      harness.repositories.externalImpacts.replaceForSource('vmz_web', [
        impact,
        impact,
      ]);

      expect(harness.repositories.externalImpacts.listAll()).toEqual([impact]);

      harness.repositories.externalImpacts.replaceForSource('vmz_web', [
        updatedImpact,
      ]);

      const rows = harness.handle.connection
        .prepare<
          [],
          { count: number }
        >('SELECT COUNT(*) AS count FROM external_impacts')
        .all();

      expect(rows[0]?.count).toBe(1);
      expect(harness.repositories.externalImpacts.listAll()).toEqual([
        updatedImpact,
      ]);
    } finally {
      destroyHarness(harness);
    }
  });

  it('finds the latest snapshot at or before a requested time for a line', () => {
    const harness = createHarness();

    try {
      harness.repositories.realtime.writeSnapshot(
        'vbn_realtime',
        '2026-06-20T06:05:00Z',
        [
          buildDelayObservation('1', '2026-06-20T06:05:00Z', 0),
          buildDelayObservation('1', '2026-06-20T06:05:30Z', 180),
        ],
      );
      harness.repositories.realtime.writeSnapshot(
        'vbn_realtime',
        '2026-06-20T06:10:00Z',
        [buildDelayObservation('4', '2026-06-20T06:10:00Z', 60)],
      );

      const snapshot = harness.repositories.realtime.findSnapshotAtOrBefore(
        '1',
        '2026-06-20T06:07:00Z',
        15 * 60,
      );

      expect(snapshot?.snapshotAt).toBe('2026-06-20T06:05:00Z');
      expect(snapshot?.observations).toBeInstanceOf(Array);
      expect(
        harness.repositories.realtime.findSnapshotAtOrBefore(
          '1',
          '2026-06-20T07:00:00Z',
          15 * 60,
        ),
      ).toBeUndefined();
    } finally {
      destroyHarness(harness);
    }
  });

  it('lists line IDs from the latest realtime snapshot even when it has no requested line', () => {
    const harness = createHarness();

    try {
      harness.repositories.realtime.writeSnapshot(
        'vbn_realtime',
        '2026-06-20T06:05:00Z',
        [
          buildDelayObservation('75236_3', '2026-06-20T06:05:00Z', 0),
          buildDelayObservation('75236_3', '2026-06-20T06:05:30Z', 180),
          buildDelayObservation('65698_3', '2026-06-20T06:05:45Z', 60),
        ],
      );
      harness.repositories.realtime.writeSnapshot(
        'vbn_realtime',
        '2026-06-20T06:10:00Z',
        [],
      );

      expect(
        harness.repositories.realtime.findSnapshotLineIdsAtOrBefore(
          'vbn_realtime',
          '2026-06-20T06:07:00Z',
          15 * 60,
        ),
      ).toEqual({
        snapshotAt: '2026-06-20T06:05:00Z',
        lineIds: ['65698_3', '75236_3'],
      });
      expect(
        harness.repositories.realtime.findSnapshotLineIdsAtOrBefore(
          'vbn_realtime',
          '2026-06-20T06:12:00Z',
          15 * 60,
        ),
      ).toEqual({
        snapshotAt: '2026-06-20T06:10:00Z',
        lineIds: [],
      });
    } finally {
      destroyHarness(harness);
    }
  });

  it('cleans up realtime snapshots older than 30 days', () => {
    const harness = createHarness();

    try {
      harness.repositories.realtime.writeSnapshot(
        'vbn_realtime',
        '2026-05-01T12:00:00Z',
        [buildDelayObservation('1', '2026-05-01T12:00:00Z', 120)],
      );
      harness.repositories.realtime.writeSnapshot(
        'vbn_realtime',
        '2026-06-20T12:00:00Z',
        [buildDelayObservation('1', '2026-06-20T12:00:00Z', 180)],
        {
          cleanupAsOf: '2026-06-20T12:00:00Z',
        },
      );

      const snapshotRows = harness.handle.connection
        .prepare<
          [],
          { count: number }
        >('SELECT COUNT(*) AS count FROM realtime_snapshots')
        .all();
      const observationRows = harness.handle.connection
        .prepare<
          [],
          { count: number }
        >('SELECT COUNT(*) AS count FROM delay_observations')
        .all();

      expect(snapshotRows[0]?.count).toBe(1);
      expect(observationRows[0]?.count).toBe(1);
      expect(
        harness.repositories.realtime.findSnapshotAtOrBefore(
          '1',
          '2026-05-02T12:00:00Z',
          15 * 60,
        ),
      ).toBeUndefined();
    } finally {
      destroyHarness(harness);
    }
  });
});
