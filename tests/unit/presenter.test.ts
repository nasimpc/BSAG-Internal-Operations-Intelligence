import { describe, expect, it } from 'vitest';

import type { ToolEnvelope } from '../../src/domain/models.js';
import { presentToolEnvelope } from '../../src/mcp/presenter.js';

describe('presentToolEnvelope', () => {
  it('renders concise English text with freshness, warnings, and a JSON fallback block', () => {
    const envelope: ToolEnvelope<{
      line_health: Array<{
        line_id: string;
        average_delay_seconds: number;
      }>;
    }> = {
      generated_at: '2026-06-20T06:00:00.000Z',
      timezone: 'Europe/Berlin',
      status: 'partial',
      data: {
        line_health: [
          {
            line_id: '10',
            average_delay_seconds: 360,
          },
        ],
      },
      citations: [
        {
          id: 'cite-1',
          source: 'vbn_realtime',
          title: 'VBN GTFS-Realtime',
          source_url: 'https://feeds.example/vbn.pb',
          alternate_urls: ['https://feeds.example/vbn.json'],
          fetched_at: '2026-06-20T05:58:58.000Z',
          claim_paths: ['/data/line_health/0'],
        },
      ],
      sources: [
        {
          source: 'vbn_realtime',
          fetched_at: '2026-06-20T05:58:58.000Z',
          age_seconds: 62,
          stale: false,
        },
        {
          source: 'vmz_web',
          stale: true,
        },
      ],
      warnings: [
        {
          source: 'vmz_web',
          code: 'SOURCE_TIMEOUT',
          message:
            'VMZ roadworks page timed out; feed-only coverage is in use.',
          occurred_at: '2026-06-20T06:00:00.000Z',
          retryable: true,
        },
      ],
    };

    const result = presentToolEnvelope({
      title: 'Line health snapshot',
      summary: ['Requested lines: 10.', 'Average delay is 6 minutes.'],
      envelope,
    });

    expect(result.structuredContent).toEqual(envelope);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: 'text',
    });

    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('Line health snapshot');
    expect(text).toContain('Requested lines: 10.');
    expect(text).toContain('Average delay is 6 minutes.');
    expect(text).toContain('Source freshness');
    expect(text).toContain('vbn_realtime');
    expect(text).toContain('62s old');
    expect(text).toContain('vmz_web');
    expect(text).toContain('Citations');
    expect(text).toContain('cite-1');
    expect(text).toContain('source_url: https://feeds.example/vbn.pb');
    expect(text).toContain('claim_paths: /data/line_health/0');
    expect(text).toContain('Warnings');
    expect(text).toContain('SOURCE_TIMEOUT');
    expect(text).toContain('```json');
    expect(text).toContain(JSON.stringify(envelope, null, 2));
  });
});
