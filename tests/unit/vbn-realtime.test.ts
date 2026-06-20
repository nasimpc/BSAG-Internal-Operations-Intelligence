import { readFileSync } from 'node:fs';

import gtfsRealtimeBindings from 'gtfs-realtime-bindings';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';

import { FixedClock } from '../../src/shared/clock.js';
import { SourceHttpClient } from '../../src/sources/http-client.js';
import {
  VbnRealtimeSource,
  decodeGtfsRealtime,
  parseVbnRealtimeJson,
} from '../../src/sources/vbn-realtime.js';

const fixture = readFileSync(
  new URL('../fixtures/vbn-realtime.json', import.meta.url),
  'utf8',
);
const malformedFixture = readFileSync(
  new URL('../fixtures/vbn-realtime-malformed.json', import.meta.url),
  'utf8',
);
const fetchedAt = '2026-06-20T05:05:00Z';
const silentLogger = pino({ enabled: false });
const agents: MockAgent[] = [];

afterEach(async () => {
  while (agents.length > 0) {
    const agent = agents.pop();

    if (agent) {
      await agent.close();
    }
  }
});

function createAgent(): MockAgent {
  const agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  agents.push(agent);
  return agent;
}

function encodeProtobufFeed(): Uint8Array {
  const message = gtfsRealtimeBindings.transit_realtime.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: '2.0',
      timestamp: Math.floor(Date.parse(fetchedAt) / 1000),
    },
    entity: [
      {
        id: 'protobuf-entity-1',
        tripUpdate: {
          trip: {
            tripId: 'protobuf-trip-1',
            routeId: '1',
          },
          stopTimeUpdate: [
            {
              stopSequence: 1,
              arrival: {
                delay: 300,
              },
            },
          ],
        },
      },
    ],
  });

  return gtfsRealtimeBindings.transit_realtime.FeedMessage.encode(
    message,
  ).finish();
}

describe('parseVbnRealtimeJson', () => {
  it('parses PascalCase VBN JSON, prefers the latest usable stop-time delay, and preserves relationships', () => {
    const outcome = parseVbnRealtimeJson(fixture, fetchedAt);

    expect(outcome.data).toContainEqual(
      expect.objectContaining({
        route_id: '1',
        trip_id: 'trip-1',
        delay_seconds: 420,
        has_usable_delay: true,
        schedule_relationship: 'scheduled',
        update_count: 3,
      }),
    );
    expect(outcome.data).toContainEqual(
      expect.objectContaining({
        route_id: '1',
        trip_id: 'trip-2',
        delay_seconds: 180,
        has_usable_delay: true,
      }),
    );
    expect(outcome.data).toContainEqual(
      expect.objectContaining({
        route_id: '1',
        trip_id: 'trip-3',
        delay_seconds: 0,
        has_usable_delay: true,
      }),
    );
    expect(outcome.data).toContainEqual(
      expect.objectContaining({
        route_id: '4',
        trip_id: 'trip-4',
        has_usable_delay: false,
        schedule_relationship: 'canceled',
      }),
    );
    expect(outcome.data).toContainEqual(
      expect.objectContaining({
        route_id: '4',
        trip_id: 'trip-5',
        has_usable_delay: false,
        schedule_relationship: 'skipped',
      }),
    );
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vbn_realtime',
        code: 'PARSER_ENTITY_INVALID',
      }),
    );
  });

  it('accepts numeric strings, derives relationships from trip and stop updates, and reports invalid entities', () => {
    const outcome = parseVbnRealtimeJson(
      JSON.stringify({
        Header: {
          Timestamp: '1718860500',
        },
        Entity: [
          'invalid entity',
          {
            Id: 'entity-1',
            TripUpdate: {
              Trip: {
                RouteId: '10',
                TripId: 'trip-10',
                ScheduleRelationship: 'SKIPPED',
              },
              Delay: '120',
            },
          },
          {
            TripUpdate: {
              Trip: {
                RouteId: '11',
                TripId: 'trip-11',
              },
              StopTimeUpdate: [
                {
                  StopSequence: '1',
                  Arrival: {
                    Delay: '60',
                  },
                },
                {
                  StopSequence: '2',
                  ScheduleRelationship: 'CANCELED',
                  Departure: {
                    Delay: '90',
                  },
                },
              ],
            },
          },
          {
            TripUpdate: {
              Trip: {
                RouteId: '12',
              },
              StopTimeUpdate: {},
            },
          },
          {
            TripUpdate: {
              Trip: {},
            },
          },
        ],
      }),
      fetchedAt,
    );

    expect(outcome.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_id: 'entity-1',
          route_id: '10',
          trip_id: 'trip-10',
          observed_at: '2024-06-20T05:15:00.000Z',
          delay_seconds: 120,
          has_usable_delay: true,
          schedule_relationship: 'skipped',
        }),
        expect.objectContaining({
          route_id: '11',
          trip_id: 'trip-11',
          observed_at: '2024-06-20T05:15:00.000Z',
          delay_seconds: 90,
          has_usable_delay: true,
          schedule_relationship: 'canceled',
          update_count: 2,
        }),
        expect.objectContaining({
          route_id: '12',
          observed_at: '2024-06-20T05:15:00.000Z',
          has_usable_delay: false,
          schedule_relationship: 'scheduled',
          update_count: 0,
        }),
      ]),
    );
    expect(
      outcome.warnings.filter(
        (warningItem) => warningItem.code === 'PARSER_ENTITY_INVALID',
      ),
    ).toHaveLength(2);
  });

  it('falls back to fetchedAt when the header timestamp is not a scalar', () => {
    const outcome = parseVbnRealtimeJson(
      JSON.stringify({
        Header: {
          Timestamp: {
            seconds: 1718860500,
          },
        },
        Entity: [
          {
            TripUpdate: {
              Trip: {
                RouteId: '14',
              },
              StopTimeUpdate: [
                {
                  StopSequence: {},
                  Arrival: {
                    Delay: 30,
                  },
                },
              ],
            },
          },
        ],
      }),
      fetchedAt,
    );

    expect(outcome.data).toEqual([
      expect.objectContaining({
        route_id: '14',
        observed_at: fetchedAt,
        delay_seconds: 30,
        has_usable_delay: true,
      }),
    ]);
  });

  it('maps protobuf feed messages into the same raw shape', () => {
    const outcome = decodeGtfsRealtime(encodeProtobufFeed(), fetchedAt);

    expect(outcome.data).toContainEqual(
      expect.objectContaining({
        route_id: '1',
        trip_id: 'protobuf-trip-1',
        delay_seconds: 300,
        has_usable_delay: true,
        schedule_relationship: 'scheduled',
      }),
    );
    expect(outcome.warnings).toEqual([]);
  });

  it('falls back to protobuf when the JSON payload cannot be parsed', async () => {
    const agent = createAgent();
    const jsonUrl = new URL('https://feeds.example/vbn.json');
    const protobufUrl = new URL('https://feeds.example/vbn.pb');
    const protobufBytes = encodeProtobufFeed();

    agent
      .get(jsonUrl.origin)
      .intercept({ path: jsonUrl.pathname, method: 'GET' })
      .reply(200, malformedFixture, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    agent
      .get(protobufUrl.origin)
      .intercept({ path: protobufUrl.pathname, method: 'GET' })
      .reply(200, Buffer.from(protobufBytes), {
        headers: { 'content-type': 'application/octet-stream' },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [jsonUrl.toString(), protobufUrl.toString()],
      dispatcher: agent,
      logger: silentLogger,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });
    const source = new VbnRealtimeSource({
      client,
      jsonUrl,
      protobufUrl,
      clock: new FixedClock(fetchedAt),
    });

    const outcome = await source.fetch();

    expect(outcome.data).toContainEqual(
      expect.objectContaining({
        route_id: '1',
        trip_id: 'protobuf-trip-1',
        delay_seconds: 300,
      }),
    );
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vbn_realtime',
        code: 'JSON_PARSER_FALLBACK',
      }),
    );
  });
});
