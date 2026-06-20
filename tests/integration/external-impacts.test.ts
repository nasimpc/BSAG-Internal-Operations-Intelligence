import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCorridors } from '../../src/config/corridors.js';
import type { ExternalImpact, SourceId } from '../../src/domain/models.js';
import { type SourceOutcome } from '../../src/domain/result.js';
import { InputError } from '../../src/shared/dates.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import {
  ExternalImpactService,
  type ExternalImpactSource,
} from '../../src/services/external-impacts.js';

interface Harness {
  close(): void;
  repositories: ReturnType<typeof createRepositories>;
}

interface ConcurrencyTracker {
  active: number;
  maxActive: number;
}

class TestClock {
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

class StubImpactSource implements ExternalImpactSource {
  readonly #outcomes: Array<SourceOutcome<ExternalImpact[]> | Error>;
  readonly #latencyMs: number;
  readonly #tracker: ConcurrencyTracker | undefined;
  readonly sourceIds: readonly SourceId[];
  callCount = 0;

  constructor(
    sourceIds: readonly SourceId[],
    outcomes: Array<SourceOutcome<ExternalImpact[]> | Error>,
    options: {
      latencyMs?: number;
      tracker?: ConcurrencyTracker;
    } = {},
  ) {
    this.sourceIds = sourceIds;
    this.#outcomes = [...outcomes];
    this.#latencyMs = options.latencyMs ?? 0;
    this.#tracker = options.tracker;
  }

  async fetch(): Promise<SourceOutcome<ExternalImpact[]>> {
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
          sources: this.sourceIds.map((source) => ({
            source,
            fetched_at: '2026-06-20T05:00:00Z',
            age_seconds: 0,
            stale: false,
          })),
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
  const dir = mkdtempSync(join(tmpdir(), 'bsag-external-impacts-'));
  const handle = openDatabase(join(dir, 'storage.sqlite'));

  return {
    repositories: createRepositories(handle),
    close(): void {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function buildImpact(
  source: SourceId,
  id: string,
  overrides: Partial<ExternalImpact> = {},
): ExternalImpact {
  return {
    id,
    title: `Impact ${id}`,
    summary: `Summary ${id}`,
    corridor_ids: [],
    category: 'incident',
    severity: 'low',
    provenance: {
      source,
      sourceUrl: `https://example.test/${source}/${id}`,
      fetchedAt: '2026-06-20T05:00:00Z',
      contentHash: `hash-${source}-${id}`,
    },
    ...overrides,
  };
}

function buildOutcome(
  sourceIds: readonly SourceId[],
  impacts: ExternalImpact[],
): SourceOutcome<ExternalImpact[]> {
  return {
    data: impacts,
    sources: sourceIds.map((source) => ({
      source,
      fetched_at: '2026-06-20T05:00:00Z',
      age_seconds: 0,
      stale: false,
    })),
    warnings: [],
  };
}

describe('ExternalImpactService', () => {
  it('refreshes sources concurrently, filters by date and corridor, deduplicates impacts, and orders by severity', async () => {
    const harness = createHarness();
    const tracker: ConcurrencyTracker = { active: 0, maxActive: 0 };
    const clock = new TestClock('2026-06-20T05:00:00Z');
    const corridors = loadCorridors(
      join(process.cwd(), 'config/corridors.json'),
    );
    const vmzSource = new StubImpactSource(
      ['vmz_pdf', 'vmz_web', 'vmz_rss'],
      [
        buildOutcome(
          ['vmz_pdf', 'vmz_web', 'vmz_rss'],
          [
            buildImpact('vmz_pdf', 'vmz-east-1', {
              title: 'Steubenstraße — Vollsperrung',
              summary: 'Peterswerder road closure at the corridor boundary',
              details: 'Peterswerder',
              starts_at: '2026-06-19T20:00:00.000Z',
              ends_at: '2026-06-19T22:00:00.000Z',
              category: 'roadworks',
              severity: 'high',
              provenance: {
                source: 'vmz_pdf',
                sourceUrl: 'https://example.test/vmz/steubenstrasse',
                fetchedAt: '2026-06-20T05:00:00Z',
                contentHash: 'hash-vmz-east-1',
              },
            }),
            buildImpact('vmz_web', 'vmz-east-duplicate', {
              title: 'Steubenstrasse Vollsperrung',
              summary: 'Peterswerder road closure at the corridor boundary',
              details: 'Peterswerder',
              starts_at: '2026-06-19T20:00:00.000Z',
              ends_at: '2026-06-19T22:00:00.000Z',
              category: 'roadworks',
              severity: 'high',
              provenance: {
                source: 'vmz_web',
                sourceUrl: 'https://example.test/vmz/steubenstrasse-web',
                fetchedAt: '2026-06-20T05:00:00Z',
                contentHash: 'hash-vmz-east-duplicate',
              },
            }),
            buildImpact('vmz_rss', 'vmz-west', {
              title: 'Use Akschen lane closure',
              summary: 'Walle disruption',
              details: 'Walle',
              starts_at: '2026-06-20T08:00:00.000Z',
              ends_at: '2026-06-20T10:00:00.000Z',
              category: 'incident',
              severity: 'moderate',
            }),
          ],
        ),
      ],
      { latencyMs: 20, tracker },
    );
    const eventsSource = new StubImpactSource(
      ['bremen_events'],
      [
        buildOutcome(
          ['bremen_events'],
          [
            buildImpact('bremen_events', 'event-east', {
              title: 'Weserpark summer concert',
              summary: 'Major concert at Weserpark',
              details: 'Weserpark',
              starts_at: '2026-06-20T16:00:00.000Z',
              ends_at: '2026-06-20T20:00:00.000Z',
              category: 'event',
              severity: 'low',
            }),
          ],
        ),
      ],
      { latencyMs: 20, tracker },
    );
    const service = new ExternalImpactService({
      clock,
      corridors,
      repositories: harness.repositories,
      sources: [vmzSource, eventsSource],
    });

    try {
      const result = await service.get({
        corridors: ['east'],
        date_from: '2026-06-20',
        date_to: '2026-06-20',
      });

      expect(tracker.maxActive).toBe(2);
      expect(vmzSource.callCount).toBe(1);
      expect(eventsSource.callCount).toBe(1);
      expect(result.data.map((impact) => impact.id)).toEqual([
        'vmz-east-1',
        'event-east',
      ]);
      expect(result.data[0]?.corridor_matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            corridor_id: 'east',
            matched_aliases: ['Peterswerder'],
          }),
        ]),
      );
      expect(result.data[1]?.corridor_matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            corridor_id: 'east',
            matched_aliases: ['Weserpark'],
          }),
        ]),
      );
    } finally {
      harness.close();
    }
  });

  it('falls back to cached impacts when one source fails and keeps partial warnings explicit', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T05:00:00Z');
    const corridors = loadCorridors(
      join(process.cwd(), 'config/corridors.json'),
    );
    const vmzSource = new StubImpactSource(
      ['vmz_pdf', 'vmz_web', 'vmz_rss'],
      [
        buildOutcome(
          ['vmz_pdf', 'vmz_web', 'vmz_rss'],
          [
            buildImpact('vmz_pdf', 'vmz-cached', {
              title: 'Steubenstraße — Vollsperrung',
              summary: 'Peterswerder road closure',
              details: 'Peterswerder',
              starts_at: '2026-06-20T06:00:00.000Z',
              ends_at: '2026-06-20T10:00:00.000Z',
              category: 'roadworks',
              severity: 'high',
            }),
          ],
        ),
        new Error('vmz source offline'),
      ],
    );
    const eventsSource = new StubImpactSource(
      ['bremen_events'],
      [
        buildOutcome(
          ['bremen_events'],
          [
            buildImpact('bremen_events', 'event-cached', {
              title: 'Weserpark concert',
              summary: 'Event at Weserpark',
              details: 'Weserpark',
              starts_at: '2026-06-20T18:00:00.000Z',
              ends_at: '2026-06-20T20:00:00.000Z',
              category: 'event',
              severity: 'low',
            }),
          ],
        ),
        buildOutcome(
          ['bremen_events'],
          [
            buildImpact('bremen_events', 'event-cached', {
              title: 'Weserpark concert',
              summary: 'Event at Weserpark',
              details: 'Weserpark',
              starts_at: '2026-06-20T18:00:00.000Z',
              ends_at: '2026-06-20T20:00:00.000Z',
              category: 'event',
              severity: 'low',
            }),
          ],
        ),
      ],
    );
    const service = new ExternalImpactService({
      clock,
      corridors,
      repositories: harness.repositories,
      sources: [vmzSource, eventsSource],
    });

    try {
      await service.get({
        date_from: '2026-06-20',
        date_to: '2026-06-20',
      });

      clock.set('2026-06-21T05:00:00Z');

      const second = await service.get({
        date_from: '2026-06-20',
        date_to: '2026-06-20',
      });

      expect(second.data.map((impact) => impact.id)).toEqual([
        'vmz-cached',
        'event-cached',
      ]);
      expect(second.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'vmz_pdf', stale: true }),
          expect.objectContaining({ source: 'vmz_web', stale: true }),
          expect.objectContaining({ source: 'vmz_rss', stale: true }),
          expect.objectContaining({ source: 'bremen_events', stale: false }),
        ]),
      );
      expect(second.warnings).toContainEqual(
        expect.objectContaining({
          source: 'vmz_pdf',
          code: 'SOURCE_REFRESH_FAILED',
          stale_cache_used: true,
        }),
      );
    } finally {
      harness.close();
    }
  });

  it('rejects unknown corridors and date ranges over 31 days', async () => {
    const harness = createHarness();
    const corridors = loadCorridors(
      join(process.cwd(), 'config/corridors.json'),
    );
    const service = new ExternalImpactService({
      clock: new TestClock('2026-06-20T05:00:00Z'),
      corridors,
      repositories: harness.repositories,
      sources: [],
    });

    try {
      await expect(
        service.get({
          corridors: ['unknown'],
          date_from: '2026-06-20',
          date_to: '2026-06-20',
        }),
      ).rejects.toBeInstanceOf(InputError);
      await expect(
        service.get({
          date_from: '2026-06-01',
          date_to: '2026-07-05',
        }),
      ).rejects.toBeInstanceOf(InputError);
    } finally {
      harness.close();
    }
  });
});
