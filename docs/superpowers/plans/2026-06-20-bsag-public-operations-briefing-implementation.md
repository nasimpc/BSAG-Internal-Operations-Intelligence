# BSAG Public Operations Briefing MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-quality TypeScript MCP server that combines public VBN, BSAG, VMZ Bremen, and Bremen event data into explainable line health, impact, notice, shift-brief, and passenger-information tools.

**Architecture:** Implement source-specific adapters behind injected interfaces, normalize all records into a small domain model, and persist observations and source state in SQLite. Domain services combine normalized records and return partial-success envelopes; one MCP registration layer is exposed through stdio and stateless Streamable HTTP transports.

**Tech Stack:** Node.js 22, TypeScript, MCP TypeScript SDK v1 (`@modelcontextprotocol/sdk`), Zod 4, Express 5, Undici, Cheerio, fast-xml-parser, pdfjs-dist, better-sqlite3, date-fns/date-fns-tz, Pino, Vitest, ESLint, Prettier, and Docker.

---

## File map

The implementation creates these focused units:

- `src/domain/models.ts`: normalized source, health, impact, notice, and risk types.
- `src/domain/result.ts`: partial-success result and warning helpers.
- `src/config/env.ts`: environment schema and runtime configuration.
- `src/config/corridors.ts`: corridor schema, loading, and deterministic matching.
- `config/corridors.json`: editable starter Bremen corridor mappings.
- `src/shared/clock.ts`: injectable clock.
- `src/shared/dates.ts`: Europe/Berlin interval parsing and overlap logic.
- `src/shared/hash.ts`: stable SHA-256 record IDs.
- `src/shared/logger.ts`: structured stderr logging.
- `src/sources/http-client.ts`: bounded, allow-listed source fetches.
- `src/sources/vbn-realtime.ts`: GTFS-Realtime JSON and protobuf normalization.
- `src/sources/vbn-notices.ts`: VBN bus/tram notice parser.
- `src/sources/bsag-notices.ts`: BSAG operational-news parser.
- `src/sources/vmz.ts`: VMZ RSS, roadworks page, PDF-link, and PDF-text parsing.
- `src/sources/bremen-events.ts`: event-card and JSON-LD parsing.
- `src/storage/database.ts`: SQLite lifecycle and migration execution.
- `src/storage/migrations.ts`: versioned SQL migrations.
- `src/storage/repositories.ts`: observations, records, and source-state repositories.
- `src/services/line-health.ts`: snapshot refresh/selection and health aggregation.
- `src/services/service-notices.ts`: notice refresh, cache fallback, and filtering.
- `src/services/external-impacts.ts`: impact refresh, deduplication, interval, and corridor filtering.
- `src/services/passenger-information.ts`: deterministic channel templates.
- `src/services/risk.ts`: explainable score and confidence computation.
- `src/services/shift-brief.ts`: 06:00–10:00 briefing orchestration.
- `src/app.ts`: dependency composition and lifecycle.
- `src/mcp/server.ts`: five MCP tool schemas and handlers.
- `src/mcp/presenter.ts`: readable text and `structuredContent` serialization.
- `src/transports/stdio.ts`: stdio entry point.
- `src/transports/http.ts`: authenticated stateless Streamable HTTP and health endpoints.
- `tests/fixtures/**`: minimized source fixtures.
- `tests/unit/**`: parser and domain tests.
- `tests/integration/**`: SQLite, service, MCP, and HTTP transport tests.
- `tests/live/**`: opt-in public-source smoke tests.

## Task 1: Scaffold the strict TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/version.ts`
- Test: `tests/unit/version.test.ts`

- [ ] **Step 1: Create the package manifest and install production dependencies**

Create `package.json` with this exact initial content:

```json
{
  "name": "@bsag/public-operations-briefing-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": {
    "bsag-mcp": "dist/transports/stdio.js",
    "bsag-mcp-http": "dist/transports/http.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:live": "BSAG_LIVE_TESTS=1 vitest run tests/live",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "check": "npm run format:check && npm run lint && npm run typecheck && npm run test:coverage && npm run build",
    "start": "node dist/transports/stdio.js",
    "start:http": "node dist/transports/http.js"
  }
}
```

Run:

```bash
npm install @modelcontextprotocol/sdk@^1 zod@^4 express@^5 undici@^7 cheerio@^1 fast-xml-parser@^5 pdfjs-dist@^5 better-sqlite3@^12 gtfs-realtime-bindings@^1 p-limit@^6 date-fns@^4 @date-fns/tz@^1 pino@^9
npm install --save-dev typescript@^5 vitest@^3 @vitest/coverage-v8@^3 eslint@^9 typescript-eslint@^8 prettier@^3 @types/node@^22 @types/express@^5 @types/better-sqlite3@^7 supertest@^7 @types/supertest@^6 tsx@^4
```

Expected: `package-lock.json` is generated and npm reports no install failure. Keep the exact versions resolved in the lockfile.

- [ ] **Step 2: Write the failing project smoke test**

Create `tests/unit/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SERVER_INFO } from '../../src/version.js';

describe('SERVER_INFO', () => {
  it('publishes a stable MCP identity', () => {
    expect(SERVER_INFO).toEqual({
      name: 'bsag-public-operations-briefing',
      version: '0.1.0',
    });
  });
});
```

- [ ] **Step 3: Run the smoke test and verify RED**

Run: `npm test -- tests/unit/version.test.ts`

Expected: FAIL because `src/version.ts` does not exist.

- [ ] **Step 4: Add strict build, lint, format, and test configuration plus the minimal module**

Create `src/version.ts`:

```ts
export const SERVER_INFO = {
  name: 'bsag-public-operations-briefing',
  version: '0.1.0',
} as const;
```

Create `tsconfig.json` with `target: ES2023`, `module/moduleResolution: NodeNext`, `rootDir: .`, `outDir: dist`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, and include `src/**/*.ts` while excluding tests from emit. Configure Vitest for Node, fixture-safe serial SQLite tests, and coverage thresholds of 90% lines/statements/functions and 85% branches for `src/domain`, `src/services`, and parser modules. Configure ESLint with `typescript-eslint` strict type-checked rules and Prettier compatibility.

- [ ] **Step 5: Run the quality checks and verify GREEN**

Run: `npm run format && npm run lint && npm run typecheck && npm test -- tests/unit/version.test.ts && npm run build`

Expected: all commands exit 0 and `dist/src/version.js` exists. If TypeScript emits under `dist/src`, change `rootDir` to `src`, remove tests from the build include, and preserve test type checking through a separate `tsconfig.test.json` referenced by Vitest.

- [ ] **Step 6: Commit the scaffold**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.js .prettierrc.json vitest.config.ts .gitignore src/version.ts tests/unit/version.test.ts
git commit -m "chore: scaffold strict TypeScript MCP project"
```

## Task 2: Define domain contracts, dates, configuration, and corridor matching

**Files:**
- Create: `src/domain/models.ts`
- Create: `src/domain/result.ts`
- Create: `src/shared/clock.ts`
- Create: `src/shared/dates.ts`
- Create: `src/shared/hash.ts`
- Create: `src/config/env.ts`
- Create: `src/config/corridors.ts`
- Create: `config/corridors.json`
- Test: `tests/unit/result.test.ts`
- Test: `tests/unit/dates.test.ts`
- Test: `tests/unit/corridors.test.ts`
- Test: `tests/unit/env.test.ts`

- [ ] **Step 1: Write failing tests for partial outcomes and date boundaries**

The tests must assert this behavior:

```ts
expect(combineOutcomes([
  { data: [1], sources: [], warnings: [] },
  { data: [2], sources: [], warnings: [{ source: 'vmz_web', code: 'SOURCE_TIMEOUT', message: 'timed out', occurred_at: now, retryable: true }] },
])).toMatchObject({ data: [1, 2], status: 'partial' });

expect(parseBerlinRange('2026-10-25', '2026-10-25').end.toISOString())
  .toBe('2026-10-25T22:59:59.999Z');
expect(intervalsOverlap(a, b)).toBe(true);
```

Also assert that `warning(...)` emits a machine-readable code and that a complete outcome has `status: "complete"`.

- [ ] **Step 2: Run the domain tests and verify RED**

Run: `npm test -- tests/unit/result.test.ts tests/unit/dates.test.ts`

Expected: FAIL with unresolved imports.

- [ ] **Step 3: Implement the normalized contracts and helpers**

Define the approved `Provenance`, `DelayObservation`, `ServiceNotice`, `ExternalImpact`, `SourceWarning`, `SourceStatus`, `LineHealth`, `RiskContribution`, `RiskAssessment`, and `ToolEnvelope<T>` types in `models.ts`. Implement this discriminated source result in `result.ts`:

```ts
export interface SourceOutcome<T> {
  data: T;
  sources: SourceStatus[];
  warnings: SourceWarning[];
}

export function envelope<T>(generatedAt: string, outcome: SourceOutcome<T>): ToolEnvelope<T> {
  return {
    generated_at: generatedAt,
    timezone: 'Europe/Berlin',
    status: outcome.warnings.length === 0 ? 'complete' : 'partial',
    data: outcome.data,
    sources: outcome.sources,
    warnings: outcome.warnings,
  };
}
```

Use `TZDate` from `@date-fns/tz` for date-only range boundaries. Reject invalid intervals and ranges over 31 days with a typed `InputError`. Implement `SystemClock`, `FixedClock`, and stable SHA-256 hashing over normalized UTF-8 text.

- [ ] **Step 4: Write failing configuration and corridor tests**

Test that configuration defaults to `Europe/Berlin`, loopback HTTP, 30-day retention, a 60-second realtime interval, and the approved source URLs. Test that malformed integer environment values fail startup validation. Test corridor matching for exact line IDs, Unicode/punctuation normalization, phrase boundaries, aliases, and the false positive `Ost` inside `Kosten`.

- [ ] **Step 5: Run configuration tests and verify RED**

Run: `npm test -- tests/unit/env.test.ts tests/unit/corridors.test.ts`

Expected: FAIL because configuration loaders do not exist.

- [ ] **Step 6: Implement environment and corridor configuration**

Use Zod coercion with bounded integers. `loadEnv(input)` must return immutable configuration and never read `process.env` at module import time. `loadCorridors(path)` must validate unique IDs and normalized aliases. Implement:

```ts
export interface CorridorMatch {
  corridor_id: string;
  confidence: 'exact' | 'phrase';
  matched_aliases: string[];
}

export function matchCorridor(corridor: Corridor, record: MatchableRecord): CorridorMatch | undefined;
```

Create starter `central`, `east`, `west`, `north`, and `south` entries. Keep the mapping conservative, document that it is editable, and include public line IDs plus well-known districts, interchange stops, streets, and venues. Do not claim geometric intersection.

- [ ] **Step 7: Run tests and commit**

Run: `npm test -- tests/unit/result.test.ts tests/unit/dates.test.ts tests/unit/env.test.ts tests/unit/corridors.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/domain src/shared src/config config/corridors.json tests/unit/result.test.ts tests/unit/dates.test.ts tests/unit/env.test.ts tests/unit/corridors.test.ts
git commit -m "feat: add domain and corridor configuration"
```

## Task 3: Build the bounded, allow-listed source HTTP client

**Files:**
- Create: `src/sources/http-client.ts`
- Create: `src/shared/logger.ts`
- Test: `tests/unit/http-client.test.ts`
- Test: `tests/unit/logger.test.ts`

- [ ] **Step 1: Write failing HTTP policy tests**

Use Undici `MockAgent` and assert:

```ts
await expect(client.getText(configuredUrl, { expectedTypes: ['text/html'] }))
  .resolves.toMatchObject({ body: '<main>ok</main>', finalUrl: configuredUrl });
await expect(client.getText(unconfiguredUrl, { expectedTypes: ['text/html'] }))
  .rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
```

Also test timeout mapping, 503 retry then success, no retry for 404, response-size rejection, content-type rejection, and redirect rejection when the target host leaves the source allow-list. Inject a zero-delay sleeper and deterministic jitter into tests.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/unit/http-client.test.ts tests/unit/logger.test.ts`

Expected: FAIL with unresolved modules.

- [ ] **Step 3: Implement the client and stderr logger**

Expose only configured-source calls:

```ts
export interface SourceHttpClient {
  getText(url: URL, policy: TextFetchPolicy): Promise<FetchResponse<string>>;
  getBytes(url: URL, policy: BinaryFetchPolicy): Promise<FetchResponse<Uint8Array>>;
}
```

Use an injected Undici dispatcher. Apply per-request `AbortSignal.timeout`, at most two transient retries with exponential backoff/jitter, a descriptive user agent, content-length and streamed-byte limits, MIME normalization, and manual redirect handling capped at three hops. Validate every redirect host. Map expected failures to source warning codes without logging response bodies. Apply a configurable p-limit queue per source host. Configure Pino to write JSON to stderr only, and use AsyncLocalStorage to attach request and tool correlation IDs plus source timing and record-count fields.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/http-client.test.ts tests/unit/logger.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/sources/http-client.ts src/shared/logger.ts tests/unit/http-client.test.ts tests/unit/logger.test.ts
git commit -m "feat: add resilient public source client"
```

## Task 4: Add SQLite migrations and repositories

**Files:**
- Create: `src/storage/migrations.ts`
- Create: `src/storage/database.ts`
- Create: `src/storage/repositories.ts`
- Test: `tests/integration/database.test.ts`
- Test: `tests/integration/repositories.test.ts`

- [ ] **Step 1: Write failing migration and repository tests**

Use a temporary database per test. Assert WAL mode, foreign keys, migration idempotency, source-state upsert, record deduplication by stable ID/content hash, snapshot selection at or before a requested time, and 30-day cleanup. The key historical assertion is:

```ts
expect(repo.findSnapshotAtOrBefore('1', '2026-06-20T06:07:00Z', 15 * 60))
  .toEqual({ snapshotAt: '2026-06-20T06:05:00Z', observations: expect.any(Array) });
expect(repo.findSnapshotAtOrBefore('1', '2026-06-20T07:00:00Z', 15 * 60))
  .toBeUndefined();
```

- [ ] **Step 2: Run repository tests and verify RED**

Run: `npm test -- tests/integration/database.test.ts tests/integration/repositories.test.ts`

Expected: FAIL with unresolved storage modules.

- [ ] **Step 3: Implement schema and transactional repositories**

Create migrations for `schema_migrations`, `realtime_snapshots`, `delay_observations`, `service_notices`, `external_impacts`, and `source_state`. Store arrays and provenance as validated JSON text. Wrap each source refresh in one transaction. Use prepared statements and explicit repository methods; do not expose raw SQL to services. `openDatabase(path)` enables WAL, foreign keys, and a 5-second busy timeout and returns a closeable handle.

- [ ] **Step 4: Verify cleanup and commit**

Run: `npm test -- tests/integration/database.test.ts tests/integration/repositories.test.ts && npm run typecheck`

Expected: PASS with no temporary database handles left open.

```bash
git add src/storage tests/integration/database.test.ts tests/integration/repositories.test.ts
git commit -m "feat: persist normalized operations data"
```

## Task 5: Implement VBN realtime ingestion and line health

**Files:**
- Create: `src/sources/vbn-realtime.ts`
- Create: `src/services/line-health.ts`
- Create: `tests/fixtures/vbn-realtime.json`
- Create: `tests/fixtures/vbn-realtime-malformed.json`
- Test: `tests/unit/vbn-realtime.test.ts`
- Test: `tests/unit/line-health.test.ts`
- Test: `tests/integration/line-health.test.ts`

- [ ] **Step 1: Write failing realtime parser tests**

The fixture must contain line `1` with delays `0`, `180`, and `420` seconds, line `4` with one update lacking delay, one skipped trip, and one malformed entity. Assert PascalCase VBN JSON handling, latest usable stop-time delay precedence, trip-level fallback, skipped/cancelled relationships, ignored malformed entities, and parser warnings.

```ts
expect(parseVbnRealtimeJson(fixture, fetchedAt).data).toContainEqual(
  expect.objectContaining({ route_id: '1', delay_seconds: 420 }),
);
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npm test -- tests/unit/vbn-realtime.test.ts`

Expected: FAIL with unresolved parser.

- [ ] **Step 3: Implement JSON normalization and optional protobuf fallback**

Schema-validate the feed header and entities while tolerating invalid individual entities. Implement `VbnRealtimeSource.fetch()` to try JSON first and protobuf after a transport, content, or parser failure when the protobuf URL is configured. Implement `decodeGtfsRealtime(bytes)` with `gtfs-realtime-bindings`, map its camelCase fields into the same internal raw shape, and test both paths without type suppressions.

- [ ] **Step 4: Write failing line-health tests**

Assert mean, median, nearest-rank p95, maximum, usable-delay coverage, on-time percentage at ≤300 seconds, early-running threshold, cancellation counts, unknown health for zero observations, low-coverage warnings, 60-second refresh coalescing, and historical snapshot selection.

- [ ] **Step 5: Run health tests and verify RED**

Run: `npm test -- tests/unit/line-health.test.ts tests/integration/line-health.test.ts`

Expected: FAIL because aggregation and orchestration are missing.

- [ ] **Step 6: Implement line health service**

Expose:

```ts
export interface GetLineHealthInput { line_ids: string[]; at_time?: string }
export class LineHealthService {
  get(input: GetLineHealthInput): Promise<SourceOutcome<LineHealth[]>>;
}
```

Deduplicate requested IDs, cap at 100, coalesce concurrent refresh promises, persist successful snapshots, and select only snapshots at or before `at_time` within 15 minutes. Calculate metrics only from usable delays. Preserve requested lines with unknown metrics when absent from the feed.

- [ ] **Step 7: Verify and commit**

Run: `npm test -- tests/unit/vbn-realtime.test.ts tests/unit/line-health.test.ts tests/integration/line-health.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/sources/vbn-realtime.ts src/services/line-health.ts tests/fixtures/vbn-realtime.json tests/fixtures/vbn-realtime-malformed.json tests/unit/vbn-realtime.test.ts tests/unit/line-health.test.ts tests/integration/line-health.test.ts
git commit -m "feat: report persisted VBN line health"
```

## Task 6: Implement BSAG and VBN service notices

**Files:**
- Create: `src/sources/vbn-notices.ts`
- Create: `src/sources/bsag-notices.ts`
- Create: `src/services/service-notices.ts`
- Create: `tests/fixtures/vbn-notices.html`
- Create: `tests/fixtures/bsag-news.html`
- Test: `tests/unit/vbn-notices.test.ts`
- Test: `tests/unit/bsag-notices.test.ts`
- Test: `tests/integration/service-notices.test.ts`

- [ ] **Step 1: Write failing VBN and BSAG parser tests**

Fixtures must include multiple notices, German date ranges, line labels, affected stops, relative links, irrelevant corporate news, and a notice with an incomplete date. Assert stable IDs, absolute source URLs, parsed effective intervals, extracted exact line tokens, and `MISSING_EFFECTIVE_DATE` for incomplete records. Assert that a structurally valid page yielding no candidate records returns `PARSER_NO_RECORDS`.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npm test -- tests/unit/vbn-notices.test.ts tests/unit/bsag-notices.test.ts`

Expected: FAIL with unresolved adapters.

- [ ] **Step 3: Implement both notice adapters**

Use Cheerio selectors with semantic fallbacks (headings, time elements, links, and labelled `Dauer`, `Linie`, and `Betroffene` text). Normalize whitespace but retain a concise source summary. Filter BSAG candidates using operational terms and explicit line/stop evidence; keep the rule list in one exported constant so parser tests expose drift.

- [ ] **Step 4: Write failing service tests**

Assert concurrent source refresh, transactionally cached records, line/stop filtering semantics, effective-or-published `since` handling, deduplication, stale-cache fallback, explicit source warnings, and result truncation warnings.

- [ ] **Step 5: Implement, verify, and commit the notice service**

Implement `ServiceNoticeService.get({ line_ids, stop_names, since })`. OR filters within each field and AND between non-empty fields. Default `since` to seven days before the injected clock. Sort effective notices first and then newest publication/fetch time.

Run: `npm test -- tests/unit/vbn-notices.test.ts tests/unit/bsag-notices.test.ts tests/integration/service-notices.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/sources/vbn-notices.ts src/sources/bsag-notices.ts src/services/service-notices.ts tests/fixtures/vbn-notices.html tests/fixtures/bsag-news.html tests/unit/vbn-notices.test.ts tests/unit/bsag-notices.test.ts tests/integration/service-notices.test.ts
git commit -m "feat: aggregate BSAG and VBN notices"
```

## Task 7: Implement VMZ traffic, roadworks, and PDF ingestion

**Files:**
- Create: `src/sources/vmz.ts`
- Create: `tests/fixtures/vmz-feed.xml`
- Create: `tests/fixtures/vmz-roadworks.html`
- Create: `tests/fixtures/vmz-roadworks.txt`
- Test: `tests/unit/vmz.test.ts`

- [ ] **Step 1: Write failing VMZ tests**

Test RSS with namespaces and malformed items, HTML discovery of weekly/special PDF links, relative URL resolution, German roadwork date ranges, locations, detour terms, and normalized PDF text. Use this text-level assertion so parser logic does not depend on a PDF engine:

```ts
expect(parseVmzRoadworksText('Steubenstraße — Vollsperrung vom 07.04.2026 bis 31.12.2028', provenance))
  .toContainEqual(expect.objectContaining({
    kind: 'roadwork',
    location_terms: expect.arrayContaining(['Steubenstraße']),
  }));
```

Add one adapter test that injects a fake `extractPdfText(bytes)` implementation and verifies byte fetch → extraction → normalization.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/vmz.test.ts`

Expected: FAIL with unresolved VMZ parser.

- [ ] **Step 3: Implement VMZ source composition**

Parse RSS with `fast-xml-parser` configured to reject/ignore DTD and external entities. Discover PDFs from current, preview, and overview pages and deduplicate URLs. Use `pdfjs-dist/legacy/build/pdf.mjs` behind `PdfTextExtractor`; concatenate page text items with spaces and enforce page/byte limits. Normalize each item to `ExternalImpact` with provenance and warnings. One bad PDF must not discard valid RSS or HTML-derived impacts.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/vmz.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/sources/vmz.ts tests/fixtures/vmz-feed.xml tests/fixtures/vmz-roadworks.html tests/fixtures/vmz-roadworks.txt tests/unit/vmz.test.ts
git commit -m "feat: ingest VMZ traffic and roadworks"
```

## Task 8: Implement Bremen events and external impact service

**Files:**
- Create: `src/sources/bremen-events.ts`
- Create: `src/services/external-impacts.ts`
- Create: `tests/fixtures/bremen-events.html`
- Test: `tests/unit/bremen-events.test.ts`
- Test: `tests/integration/external-impacts.test.ts`

- [ ] **Step 1: Write failing event parser tests**

Include JSON-LD `Event` objects, repeated events, HTML cards, all-day dates, timed events, locations, relative links, and incomplete items. Prefer JSON-LD when the same event appears in both forms. Assert stable deduplication and explicit warnings for missing effective dates.

- [ ] **Step 2: Run parser test and verify RED**

Run: `npm test -- tests/unit/bremen-events.test.ts`

Expected: FAIL with unresolved parser.

- [ ] **Step 3: Implement event parsing**

Parse `application/ld+json`, recursively flatten `@graph`, accept only `@type: Event`, and fall back to semantic cards when JSON-LD is absent. Never execute scripts. Convert event venue/address fields into location terms and preserve the official detail URL.

- [ ] **Step 4: Write failing impact-service tests**

Assert concurrent VMZ/event fetch, inclusive interval overlap, 31-day validation, configured corridor filtering, exact matched aliases, normalized-title/location/time deduplication, severity ordering, stale cache, and partial success when either source fails.

- [ ] **Step 5: Implement, verify, and commit**

Implement `ExternalImpactService.get({ corridors, date_from, date_to })`. Unknown corridors are `InputError`s. A no-corridor request returns all matching-date impacts. Every filtered record includes its `corridor_matches`; do not infer geometric overlap.

Run: `npm test -- tests/unit/bremen-events.test.ts tests/integration/external-impacts.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/sources/bremen-events.ts src/services/external-impacts.ts tests/fixtures/bremen-events.html tests/unit/bremen-events.test.ts tests/integration/external-impacts.test.ts
git commit -m "feat: report corridor external impacts"
```

## Task 9: Implement deterministic passenger information

**Files:**
- Create: `src/services/passenger-information.ts`
- Test: `tests/unit/passenger-information.test.ts`

- [ ] **Step 1: Write failing channel-template tests**

Assert unique sorted line labels, whitespace normalization, HTML stripping, app output ≤240 characters, stop output ≤160 characters, web heading plus two concise paragraphs, cautious wording (`may be affected`) by default, and `manual_edit_required` when essential line/issue content cannot fit.

```ts
expect(draftPassengerInformation({
  line_ids: ['4', '1', '4'],
  issue_summary: 'Roadworks may affect the eastern corridor tomorrow morning.',
  channel: 'stop',
}).text.length).toBeLessThanOrEqual(160);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/passenger-information.test.ts`

Expected: FAIL with unresolved function.

- [ ] **Step 3: Implement bounded templates without an LLM**

Use channel-specific sentence priorities. Truncate only optional advice; never truncate all line IDs or the core issue. Return `{ channel, text, character_count, manual_edit_required, warnings }`. Treat input as plain text and reject empty or >2,000-character summaries.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/passenger-information.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/services/passenger-information.ts tests/unit/passenger-information.test.ts
git commit -m "feat: draft bounded passenger information"
```

## Task 10: Implement explainable risk scoring and shift briefs

**Files:**
- Create: `src/services/risk.ts`
- Create: `src/services/shift-brief.ts`
- Test: `tests/unit/risk.test.ts`
- Test: `tests/integration/shift-brief.test.ts`

- [ ] **Step 1: Write failing risk tests for every contribution**

Table-test delay (0–30), on-time (0–15), low non-zero coverage (0–5), notice (0–25), roadwork/traffic (0–20), event (0–10), and overlap (0–10) contributions. Assert cap 100, exact band boundaries 24/25/49/50/74/75, zero-observation unknown behavior, and low/medium/high confidence based on source freshness and match quality.

Each returned contribution must contain `kind`, `points`, and a human-readable `reason` naming the evidence.

- [ ] **Step 2: Run scoring tests and verify RED**

Run: `npm test -- tests/unit/risk.test.ts`

Expected: FAIL with unresolved scorer.

- [ ] **Step 3: Implement pure risk scoring**

Keep thresholds in an injected `RiskConfig`. Make `assessRisk(input, config)` pure. Missing sources lower confidence and append warnings but do not subtract points or imply safety. Sort contributions by points descending and stable kind order.

- [ ] **Step 4: Write failing shift-brief integration tests**

With fixed time `2026-06-19T12:00:00Z`, build the `2026-06-20` east brief. Assert a Europe/Berlin window of 06:00–10:00, configured candidate lines, current/recent baseline wording, line and corridor ranking, explicit VMZ/realtime overlap, major events, source warnings, and optional comms only for high/severe risk.

- [ ] **Step 5: Implement the brief orchestrator**

Inject line-health, notices, impacts, scorer, corridors, clock, and passenger drafter. Fetch independent inputs concurrently with `Promise.allSettled`; convert unexpected dependency failures to warnings. Return structured data containing shift window, baseline time, ranked assessments, evidence, operational actions, optional drafts, and limitations plus a concise text renderer input.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/unit/risk.test.ts tests/integration/shift-brief.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/services/risk.ts src/services/shift-brief.ts tests/unit/risk.test.ts tests/integration/shift-brief.test.ts
git commit -m "feat: build explainable shift risk briefs"
```

## Task 11: Register and contract-test all MCP tools

**Files:**
- Create: `src/mcp/presenter.ts`
- Create: `src/mcp/server.ts`
- Test: `tests/unit/presenter.test.ts`
- Test: `tests/integration/mcp-tools.test.ts`

- [ ] **Step 1: Write failing presenter and tool-contract tests**

Use MCP `Client` with an in-memory transport pair. Assert exactly five listed tools, descriptions that state public-source limitations, Zod validation, readable English text, and `structuredContent` matching the tool output schema. Assert invalid input returns `isError: true`, while an upstream timeout returns `status: "partial"` with `isError` absent/false.

- [ ] **Step 2: Run MCP tests and verify RED**

Run: `npm test -- tests/unit/presenter.test.ts tests/integration/mcp-tools.test.ts`

Expected: FAIL with unresolved MCP server.

- [ ] **Step 3: Implement schemas and tool registration**

Create a fresh `McpServer(SERVER_INFO)` per transport connection/request and register:

```ts
registerTool('get_line_health', { inputSchema, outputSchema, description }, handler);
registerTool('get_external_impacts', { inputSchema, outputSchema, description }, handler);
registerTool('get_service_notices', { inputSchema, outputSchema, description }, handler);
registerTool('build_shift_brief', { inputSchema, outputSchema, description }, handler);
registerTool('draft_passenger_information', { inputSchema, outputSchema, description }, handler);
```

Use Zod 4 schemas with strict objects, input bounds, ISO date/datetime refinement, and deduplicated arrays. Convert `InputError` to an MCP error result. Preserve partial upstream outcomes as normal results. Presenter text must be concise and include freshness plus warnings; put the full envelope in `structuredContent` and JSON-stringify the same envelope in a text block for clients that ignore structured output.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/presenter.test.ts tests/integration/mcp-tools.test.ts && npm run typecheck`

Expected: PASS and the client lists all five tools.

```bash
git add src/mcp tests/unit/presenter.test.ts tests/integration/mcp-tools.test.ts
git commit -m "feat: expose operations briefing MCP tools"
```

## Task 12: Compose the app and expose stdio and secure Streamable HTTP

**Files:**
- Create: `src/app.ts`
- Create: `src/transports/stdio.ts`
- Create: `src/transports/http.ts`
- Test: `tests/integration/stdio.test.ts`
- Test: `tests/integration/http.test.ts`

- [ ] **Step 1: Write failing app lifecycle and stdio tests**

Spawn the built stdio entry, use `StdioClientTransport`, list tools, call `draft_passenger_information`, and assert stdout contains only MCP frames. Assert SIGTERM closes the database and exits 0. Inject fixture-backed sources through a test composition option; never contact public endpoints in this test.

- [ ] **Step 2: Write failing HTTP security and protocol tests**

With Supertest, assert `/health/live` is 200, `/health/ready` reflects database readiness, POST `/mcp` handles MCP initialization/tool calls, GET/DELETE `/mcp` return protocol-shaped 405 responses in stateless mode, oversized JSON is 413, disallowed `Origin` is 403, and a non-loopback configuration without a bearer token fails startup. Assert constant-time bearer validation behavior through outcomes, not timing measurements.

- [ ] **Step 3: Run transport tests and verify RED**

Run: `npm run build && npm test -- tests/integration/stdio.test.ts tests/integration/http.test.ts`

Expected: FAIL with missing app/transports.

- [ ] **Step 4: Implement dependency composition and lifecycle**

`createApplication(options)` loads config, corridors, database, repositories, source adapters, services, and logger and returns `{ createMcpServer, readiness, close }`. It accepts injected clock, HTTP dispatcher, PDF extractor, data path, and logger for tests. No import creates directories, opens SQLite, or starts network listeners.

- [ ] **Step 5: Implement both transports**

Stdio connects one MCP server to `StdioServerTransport` and logs only to stderr. HTTP uses `createMcpExpressApp({ host })`, an explicit 1 MiB JSON limit, origin validation, optional/required bearer middleware, and one fresh server plus `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST. Close request-scoped transport/server on response close. Bind to `127.0.0.1` by default. Handle SIGINT/SIGTERM once and shut down gracefully.

- [ ] **Step 6: Verify and commit**

Run: `npm run build && npm test -- tests/integration/stdio.test.ts tests/integration/http.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/app.ts src/transports tests/integration/stdio.test.ts tests/integration/http.test.ts
git commit -m "feat: serve MCP over stdio and HTTP"
```

## Task 13: Add operations packaging, documentation, CI, and live smoke tests

**Files:**
- Create: `.env.example`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `docs/operations.md`
- Create: `tests/live/public-sources.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the opt-in live smoke test**

The suite must skip unless `BSAG_LIVE_TESTS=1`. When enabled, fetch each configured official source with production limits and assert only transport/content invariants: successful sources parse without crashing, and unavailable/changed sources produce structured warnings rather than failing the suite as an unhandled exception. Print source status without source body content.

- [ ] **Step 2: Add runtime and client documentation**

Document Node 22, install/build, stdio configuration, Streamable HTTP startup, bearer/origin rules, environment variables, corridor editing, SQLite retention, five tool examples, partial-result semantics, risk limitations, attribution, source URLs, live-smoke execution, and troubleshooting parser warnings. Include this client example:

```json
{
  "mcpServers": {
    "bsag-briefing": {
      "command": "node",
      "args": ["/absolute/path/to/BSAG-MCP/dist/transports/stdio.js"],
      "env": { "BSAG_MCP_DATA_DIR": "/absolute/path/to/data" }
    }
  }
}
```

- [ ] **Step 3: Add Docker and CI packaging**

Use `node:22-bookworm-slim` multi-stage build, `npm ci`, production dependency pruning, a non-root runtime user, and `/data` as the only writable volume. The CI workflow uses Node 22 with npm cache and runs `npm ci`, `npm run check`, and `npm audit --omit=dev --audit-level=high`. Do not run live tests in normal CI.

- [ ] **Step 4: Run the complete deterministic quality gate**

Run: `npm run check`

Expected: formatting, lint, strict type checking, coverage thresholds, all deterministic tests, and production build pass.

- [ ] **Step 5: Run package and container smoke checks**

Run:

```bash
npm pack --dry-run
docker build -t bsag-briefing-mcp:test .
docker run --rm bsag-briefing-mcp:test node --version
```

Expected: package contains `dist`, README, and config; image builds; container prints Node 22. If Docker is unavailable, record that exact limitation and still verify `npm pack --dry-run` plus direct Node startup.

- [ ] **Step 6: Run opt-in public-source smoke checks**

Run: `npm run test:live`

Expected: each source either yields records/status or a structured warning; no unhandled rejection or process crash. Live parser warnings must be reported in the handoff and must not be hidden by fixtures.

- [ ] **Step 7: Commit documentation and packaging**

```bash
git add .env.example Dockerfile .dockerignore .github/workflows/ci.yml README.md docs/operations.md tests/live/public-sources.test.ts package.json package-lock.json
git commit -m "docs: package and operate briefing server"
```

## Task 14: Final specification audit and release verification

**Files:**
- Modify only files required to correct audit findings.

- [ ] **Step 1: Audit every acceptance criterion against tests**

Create a temporary checklist from design sections 3–14. For each acceptance criterion, name the automated test and production file that satisfy it. Add a focused failing test before fixing any uncovered behavior. Do not add unrelated features.

- [ ] **Step 2: Scan for placeholders and unsafe shortcuts**

Run:

```bash
rg -n -e 'TODO' -e 'FIXME' -e 'TBD' -e 'as any' -e '@ts-ignore' src tests README.md docs config
```

Expected: no unresolved placeholders or type-safety suppressions. Review any intentional match in fixture text manually.

- [ ] **Step 3: Run final verification on Node 22**

Run:

```bash
node --version
npm ci
npm run check
git diff --check
git status --short
```

Expected: Node reports v22.x; install and all checks pass; no whitespace errors; only intentional tracked changes remain.

- [ ] **Step 4: Commit audit fixes if needed**

```bash
git add src tests README.md docs config package.json package-lock.json
git commit -m "fix: close briefing server audit gaps"
```

Skip this commit when the audit required no changes.
