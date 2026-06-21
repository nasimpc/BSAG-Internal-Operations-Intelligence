import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ServiceNotice, SourceId } from '../../src/domain/models.js';
import { type SourceOutcome, warning } from '../../src/domain/result.js';
import type { Clock } from '../../src/shared/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import {
  ServiceNoticeService,
  type ServiceNoticeSource,
} from '../../src/services/service-notices.js';

interface Harness {
  close(): void;
  repositories: ReturnType<typeof createRepositories>;
}

interface ConcurrencyTracker {
  active: number;
  maxActive: number;
}

class TestClock implements Clock {
  #value: Date;

  constructor(value: string) {
    this.#value = new Date(value);
  }

  now(): Date {
    return new Date(this.#value);
  }

  set(value: string): void {
    this.#value = new Date(value);
  }
}

class StubNoticeSource implements ServiceNoticeSource {
  readonly #outcomes: Array<SourceOutcome<ServiceNotice[]> | Error>;
  readonly #latencyMs: number;
  readonly #tracker: ConcurrencyTracker | undefined;
  readonly sourceId: Extract<SourceId, 'bsag' | 'vbn_notices'>;
  callCount = 0;

  constructor(
    sourceId: Extract<SourceId, 'bsag' | 'vbn_notices'>,
    outcomes: Array<SourceOutcome<ServiceNotice[]> | Error>,
    options: {
      latencyMs?: number;
      tracker?: ConcurrencyTracker;
    } = {},
  ) {
    this.sourceId = sourceId;
    this.#outcomes = [...outcomes];
    this.#latencyMs = options.latencyMs ?? 0;
    this.#tracker = options.tracker;
  }

  async fetch(): Promise<SourceOutcome<ServiceNotice[]>> {
    this.callCount += 1;

    if (this.#tracker !== undefined) {
      this.#tracker.active += 1;
      this.#tracker.maxActive = Math.max(
        this.#tracker.maxActive,
        this.#tracker.active,
      );
    }

    try {
      if (this.#latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
      }

      const next = this.#outcomes.shift();

      if (next instanceof Error) {
        throw next;
      }

      return (
        next ?? {
          data: [],
          sources: [
            {
              source: this.sourceId,
              fetched_at: '2026-06-20T12:00:00Z',
              age_seconds: 0,
              stale: false,
            },
          ],
          warnings: [],
        }
      );
    } finally {
      if (this.#tracker !== undefined) {
        this.#tracker.active -= 1;
      }
    }
  }
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'bsag-service-notices-'));
  const handle = openDatabase(join(dir, 'storage.sqlite'));
  const repositories = createRepositories(handle);

  return {
    repositories,
    close(): void {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function buildNotice(
  source: Extract<SourceId, 'bsag' | 'vbn_notices'>,
  id: string,
  overrides: Partial<ServiceNotice> = {},
): ServiceNotice {
  return {
    id,
    title: `Notice ${id}`,
    summary: `Summary ${id}`,
    lines: ['1'],
    stop_names: ['Hauptbahnhof'],
    severity: 'warning',
    provenance: {
      source,
      sourceUrl: `https://example.test/${source}/${id}`,
      fetchedAt: '2026-06-20T12:00:00Z',
      contentHash: `hash-${source}-${id}`,
    },
    ...overrides,
  };
}

function buildOutcome(
  source: Extract<SourceId, 'bsag' | 'vbn_notices'>,
  fetchedAt: string,
  notices: ServiceNotice[],
  warnings: SourceOutcome<ServiceNotice[]>['warnings'] = [],
): SourceOutcome<ServiceNotice[]> {
  return {
    data: notices.map((notice) => ({
      ...notice,
      provenance: {
        ...notice.provenance,
        source,
        fetchedAt,
      },
    })),
    sources: [
      {
        source,
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

describe('ServiceNoticeService', () => {
  it('refreshes sources concurrently, filters and deduplicates results, and warns when truncated', async () => {
    const harness = createHarness();
    const tracker: ConcurrencyTracker = { active: 0, maxActive: 0 };
    const clock = new TestClock('2026-06-20T12:00:00Z');
    const duplicateFromBsag = buildNotice('bsag', 'bsag-6', {
      title: 'Linie 6 diversion',
      summary: 'Diversion affects Flughafen Bremen',
      lines: ['6'],
      stop_names: ['Flughafen Bremen'],
      valid_from: '2026-06-21T03:00:00.000Z',
      valid_to: '2026-06-22T03:00:00.000Z',
      provenance: {
        source: 'bsag',
        sourceUrl: 'https://example.test/bsag/linie-6',
        fetchedAt: '2026-06-20T12:00:00Z',
        publishedAt: '2026-06-20T11:00:00Z',
        contentHash: 'hash-duplicate',
      },
    });
    const duplicateFromVbn = buildNotice('vbn_notices', 'vbn-6', {
      title: duplicateFromBsag.title,
      summary: duplicateFromBsag.summary,
      lines: duplicateFromBsag.lines,
      stop_names: duplicateFromBsag.stop_names,
      ...(duplicateFromBsag.valid_from === undefined
        ? {}
        : { valid_from: duplicateFromBsag.valid_from }),
      ...(duplicateFromBsag.valid_to === undefined
        ? {}
        : { valid_to: duplicateFromBsag.valid_to }),
      provenance: {
        source: 'vbn_notices',
        sourceUrl: 'https://example.test/vbn/linie-6',
        fetchedAt: '2026-06-20T12:00:00Z',
        publishedAt: '2026-06-20T10:00:00Z',
        contentHash: 'hash-duplicate',
      },
    });
    const bsagSource = new StubNoticeSource(
      'bsag',
      [
        buildOutcome('bsag', '2026-06-20T12:00:00Z', [
          buildNotice('bsag', 'bsag-4', {
            title: 'Linie 4 stop closure',
            summary: 'Domsheide stop is closed',
            lines: ['4'],
            stop_names: ['Domsheide'],
            provenance: {
              source: 'bsag',
              sourceUrl: 'https://example.test/bsag/linie-4',
              fetchedAt: '2026-06-20T12:00:00Z',
              publishedAt: '2026-06-20T08:00:00Z',
              contentHash: 'hash-bsag-4',
            },
          }),
          duplicateFromBsag,
          buildNotice('bsag', 'bsag-line-only', {
            title: 'Linie 4 stop change',
            lines: ['4'],
            stop_names: ['Findorff'],
            provenance: {
              source: 'bsag',
              sourceUrl: 'https://example.test/bsag/linie-4-findorff',
              fetchedAt: '2026-06-20T12:00:00Z',
              publishedAt: '2026-06-20T09:00:00Z',
              contentHash: 'hash-line-only',
            },
          }),
          buildNotice('bsag', 'bsag-old', {
            title: 'Old notice',
            lines: ['6'],
            stop_names: ['Flughafen Bremen'],
            provenance: {
              source: 'bsag',
              sourceUrl: 'https://example.test/bsag/old',
              fetchedAt: '2026-06-20T12:00:00Z',
              publishedAt: '2026-06-19T20:00:00Z',
              contentHash: 'hash-old',
            },
          }),
        ]),
      ],
      { latencyMs: 25, tracker },
    );
    const vbnSource = new StubNoticeSource(
      'vbn_notices',
      [
        buildOutcome(
          'vbn_notices',
          '2026-06-20T12:00:00Z',
          [
            duplicateFromVbn,
            buildNotice('vbn_notices', 'vbn-8', {
              title: 'Linie 8 reroute',
              summary: 'Reroute affects Hauptbahnhof',
              lines: ['8'],
              stop_names: ['Hauptbahnhof'],
              valid_from: '2026-06-19T06:00:00.000Z',
              valid_to: '2026-06-20T10:00:00.000Z',
              provenance: {
                source: 'vbn_notices',
                sourceUrl: 'https://example.test/vbn/linie-8',
                fetchedAt: '2026-06-20T09:00:00Z',
                contentHash: 'hash-vbn-8',
              },
            }),
            buildNotice('vbn_notices', 'vbn-stop-only', {
              title: 'Domsheide platform change',
              lines: ['9'],
              stop_names: ['Domsheide'],
              valid_from: '2026-06-20T03:00:00.000Z',
              valid_to: '2026-06-20T04:00:00.000Z',
              provenance: {
                source: 'vbn_notices',
                sourceUrl: 'https://example.test/vbn/domsheide',
                fetchedAt: '2026-06-20T12:00:00Z',
                contentHash: 'hash-stop-only',
              },
            }),
          ],
          [
            warning(
              'vbn_notices',
              'MISSING_EFFECTIVE_DATE',
              'Fixture warning from parser',
              {
                occurredAt: '2026-06-20T12:00:00Z',
                retryable: false,
              },
            ),
          ],
        ),
      ],
      { latencyMs: 25, tracker },
    );
    const service = new ServiceNoticeService({
      clock,
      maxResults: 2,
      repositories: harness.repositories,
      sources: [bsagSource, vbnSource],
    });

    try {
      const result = await service.get({
        line_ids: ['4', '6', '8'],
        since: '2026-06-20T00:00:00Z',
        stop_names: ['Domsheide', 'Flughafen Bremen', 'Hauptbahnhof'],
      });

      expect(tracker.maxActive).toBe(2);
      expect(bsagSource.callCount).toBe(1);
      expect(vbnSource.callCount).toBe(1);
      expect(result.data.map((notice) => notice.id)).toEqual([
        'vbn-8',
        'bsag-6',
      ]);
      expect(result.data.map((notice) => notice.provenance.source)).toEqual([
        'vbn_notices',
        'bsag',
      ]);
      expect(result.data.some((notice) => notice.id === 'vbn-6')).toBe(false);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          source: 'vbn_notices',
          code: 'MISSING_EFFECTIVE_DATE',
        }),
      );
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: 'RESULT_TRUNCATED',
        }),
      );
    } finally {
      harness.close();
    }
  });

  it('defaults since to seven days before the clock and falls back to cached records when refresh fails', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T12:00:00Z');
    const bsagSource = new StubNoticeSource('bsag', [
      buildOutcome('bsag', '2026-06-20T12:00:00Z', [
        buildNotice('bsag', 'bsag-recent', {
          title: 'Recent Linie 4 notice',
          lines: ['4'],
          stop_names: ['Domsheide'],
          provenance: {
            source: 'bsag',
            sourceUrl: 'https://example.test/bsag/recent',
            fetchedAt: '2026-06-20T12:00:00Z',
            publishedAt: '2026-06-20T08:00:00Z',
            contentHash: 'hash-bsag-recent',
          },
        }),
        buildNotice('bsag', 'bsag-too-old', {
          title: 'Too old Linie 4 notice',
          lines: ['4'],
          stop_names: ['Domsheide'],
          provenance: {
            source: 'bsag',
            sourceUrl: 'https://example.test/bsag/too-old',
            fetchedAt: '2026-06-20T12:00:00Z',
            publishedAt: '2026-06-13T11:59:00Z',
            contentHash: 'hash-bsag-too-old',
          },
        }),
      ]),
      new Error('bsag upstream unavailable'),
    ]);
    const vbnSource = new StubNoticeSource('vbn_notices', [
      buildOutcome('vbn_notices', '2026-06-20T12:00:00Z', [
        buildNotice('vbn_notices', 'vbn-recent', {
          title: 'Recent Linie 6 notice',
          lines: ['6'],
          stop_names: ['Flughafen Bremen'],
          valid_from: '2026-06-18T06:00:00.000Z',
          valid_to: '2026-06-21T06:00:00.000Z',
          provenance: {
            source: 'vbn_notices',
            sourceUrl: 'https://example.test/vbn/recent',
            fetchedAt: '2026-06-20T12:00:00Z',
            contentHash: 'hash-vbn-recent',
          },
        }),
      ]),
      new Error('vbn upstream unavailable'),
    ]);
    const service = new ServiceNoticeService({
      clock,
      repositories: harness.repositories,
      sources: [bsagSource, vbnSource],
    });

    try {
      const first = await service.get({
        line_ids: ['4', '6'],
        stop_names: ['Domsheide', 'Flughafen Bremen'],
      });

      expect(first.data.map((notice) => notice.id)).toEqual([
        'vbn-recent',
        'bsag-recent',
      ]);
      expect(first.data.some((notice) => notice.id === 'bsag-too-old')).toBe(
        false,
      );
      expect(harness.repositories.serviceNotices.listAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'bsag-recent' }),
          expect.objectContaining({ id: 'vbn-recent' }),
        ]),
      );

      clock.set('2026-06-22T12:00:00Z');

      const second = await service.get({
        line_ids: ['4', '6'],
        stop_names: ['Domsheide', 'Flughafen Bremen'],
      });

      expect(bsagSource.callCount).toBe(2);
      expect(vbnSource.callCount).toBe(2);
      expect(second.data.map((notice) => notice.id)).toEqual([
        'vbn-recent',
        'bsag-recent',
      ]);
      expect(second.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'bsag', stale: true }),
          expect.objectContaining({ source: 'vbn_notices', stale: true }),
        ]),
      );
      expect(
        second.warnings.filter(
          (warningItem) => warningItem.code === 'SOURCE_REFRESH_FAILED',
        ),
      ).toHaveLength(2);
      expect(second.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'bsag',
            code: 'SOURCE_REFRESH_FAILED',
            stale_cache_used: true,
          }),
          expect.objectContaining({
            source: 'vbn_notices',
            code: 'SOURCE_REFRESH_FAILED',
            stale_cache_used: true,
          }),
        ]),
      );
    } finally {
      harness.close();
    }
  });

  it('keeps open-ended effective notices active beyond the default lookback', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T12:00:00Z');
    const bsagSource = new StubNoticeSource('bsag', [
      buildOutcome('bsag', '2026-06-20T12:00:00Z', []),
    ]);
    const vbnSource = new StubNoticeSource('vbn_notices', [
      buildOutcome('vbn_notices', '2026-06-20T12:00:00Z', [
        buildNotice('vbn_notices', 'vbn-open-ended', {
          title: 'Linie 6 open-ended diversion',
          lines: ['6'],
          stop_names: ['Flughafen Bremen'],
          valid_from: '2026-04-07T01:00:00.000Z',
          provenance: {
            source: 'vbn_notices',
            sourceUrl: 'https://example.test/vbn/open-ended',
            fetchedAt: '2026-06-20T12:00:00Z',
            contentHash: 'hash-vbn-open-ended',
          },
        }),
      ]),
    ]);
    const service = new ServiceNoticeService({
      clock,
      repositories: harness.repositories,
      sources: [bsagSource, vbnSource],
    });

    try {
      const result = await service.get({
        line_ids: ['6'],
        stop_names: ['Flughafen Bremen'],
      });

      expect(result.data.map((notice) => notice.id)).toEqual([
        'vbn-open-ended',
      ]);
      expect(result.warnings).toEqual([]);
    } finally {
      harness.close();
    }
  });
});
