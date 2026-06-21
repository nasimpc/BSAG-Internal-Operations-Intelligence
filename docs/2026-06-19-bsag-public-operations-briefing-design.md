# BSAG Public Operations Briefing MCP Server — Design

**Date:** 2026-06-19
**Status:** Approved for implementation planning
**Runtime:** TypeScript on Node.js 22
**Output language:** English

## 1. Purpose

Build an MCP server for internal operations staff that combines public BSAG/VBN service information, VBN GTFS-Realtime observations, VMZ Bremen traffic impacts, and Bremen event information. The server identifies service risk for BSAG bus and tram lines, explains the evidence behind each assessment, and drafts concise passenger information.

The server is an operational decision-support tool, not a predictive control system. It must distinguish current observations, scheduled impacts, cached data, and inferred risk. It must continue with partial results when individual public sources fail and expose those limitations in every affected response.

## 2. Scope

### In scope

- Five MCP tools: `get_line_health`, `get_external_impacts`, `get_service_notices`, `build_shift_brief`, and `draft_passenger_information`.
- Stdio and Streamable HTTP transports backed by the same tool implementations.
- Public-source ingestion from VBN, BSAG, VMZ Bremen, and bremen.de.
- SQLite persistence for realtime observations, normalized scraped records, source state, and migrations.
- An editable Bremen corridor configuration containing aliases for lines, route names, stops, streets, districts, venues, and places.
- Explainable risk scoring and deterministic English communications templates.
- Structured data plus a concise human-readable summary from each tool.

### Out of scope

- Registered VBN Connect static GTFS downloads or credentials.
- Claims about future delays based on unavailable future realtime data.
- Automatic publication of passenger messages.
- A web user interface.
- Geospatial route intersection requiring static route shapes.
- An embedded LLM or proprietary API.

## 3. Public Sources

Default source URLs are configuration, not hard-coded throughout the application:

| Source                     | Default endpoint                                                      | Primary use                                 |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| VBN GTFS-Realtime JSON     | `http://gtfsr.vbn.de/gtfsr_connect.json`                              | Current trip delays and route IDs           |
| VBN GTFS-Realtime protobuf | `http://gtfsr.vbn.de/gtfsr_connect.bin`                               | Optional fallback for realtime observations |
| VBN bus/tram notices       | `https://www.vbn.de/vbn/verkehrshinweise/bus-und-strassenbahnverkehr` | Planned diversions and service changes      |
| BSAG current news          | `https://www.bsag.de/unternehmen/aktuelles`                           | BSAG operational announcements              |
| VMZ current roadworks      | `https://vmz.bremen.de/baustellen/aktuell`                            | Current traffic impacts                     |
| VMZ roadworks preview      | `https://vmz.bremen.de/baustellen/vorschau`                           | Future traffic impacts                      |
| VMZ roadworks overview     | `https://vmz.bremen.de/baustellen/baustellenuebersicht`               | Weekly and special PDF notices              |
| VMZ RSS                    | `https://vmz.bremen.de/verkehrslage/aktuell/feed.rss`                 | Current traffic alerts                      |
| Bremen event calendar      | `https://www.bremen.de/kultur/veranstaltungen`                        | Public events and dates                     |

Source adapters must tolerate redirects and site redesigns by failing independently with a parser warning. Parsed records retain source URL, fetch time, source publication/effective dates where available, and a content hash. The implementation must not imply completeness: VBN itself notes that its notices may not list every change.

## 4. Architecture

The server uses a modular adapter architecture:

- `src/config`: validated environment settings, risk thresholds, retention, source URLs, and corridor configuration loading.
- `src/domain`: normalized domain records and response contracts with no network, database, or MCP dependencies.
- `src/sources`: one adapter per public source. Each adapter fetches and parses source-specific representations into normalized records.
- `src/storage`: SQLite connection setup, migrations, repositories, deduplication, source-state tracking, and retention cleanup.
- `src/services`: line-health aggregation, impact relevance, corridor matching, notice filtering, risk scoring, brief assembly, and communications drafting.
- `src/mcp`: Zod input schemas, MCP tool registration, response serialization, and transport-neutral handlers.
- `src/transports`: stdio and Streamable HTTP startup code.

Source adapters, clocks, and repositories are injected behind narrow interfaces. This keeps parsers fixture-testable and prevents MCP protocol concerns from leaking into domain services.

## 5. Normalized Domain Model

All source-derived records carry a provenance object:

```ts
interface Provenance {
  source:
    | 'vbn_realtime'
    | 'vbn_notices'
    | 'bsag'
    | 'vmz_rss'
    | 'vmz_web'
    | 'vmz_pdf'
    | 'bremen_events';
  sourceUrl: string;
  fetchedAt: string;
  publishedAt?: string;
  contentHash?: string;
}
```

Core records are:

- `DelayObservation`: snapshot time, entity/trip ID, route ID, trip relationship, representative delay seconds, and update count.
- `ServiceNotice`: stable ID, title, summary, lines, stops, effective interval, publication time, URL, and provenance.
- `ExternalImpact`: stable ID, kind (`roadwork`, `detour`, `traffic_alert`, or `event`), title, summary, location terms, effective interval, severity hints, URL, and provenance.
- `SourceWarning`: source, machine-readable code, human-readable message, occurrence time, retryability, and stale-cache metadata.
- `LineHealth`: line ID, snapshot details, counts, feed coverage, delay metrics, on-time percentage, cancellations/skips where available, and warnings.
- `RiskAssessment`: line/corridor, 0–100 score, `low`/`moderate`/`high`/`severe` band, and additive evidence contributions.

Dates crossing daylight-saving changes are interpreted in `Europe/Berlin`. External API timestamps are emitted as ISO 8601 strings with offsets or `Z`.

## 6. Fetching, Parsing, and Persistence

Each source has a bounded fetch policy: configurable timeout, at most two retries for transient idempotent failures, exponential backoff with jitter, maximum response size, expected content-type checks, and a descriptive user agent. A small concurrency limit protects public sites. Realtime refreshes are coalesced so concurrent tool calls do not trigger duplicate downloads.

HTML is parsed without executing scripts. RSS/XML parsing rejects external entities. PDF extraction is size-limited and isolated behind the VMZ adapter. Parser output is schema-validated before persistence.

SQLite runs in WAL mode with foreign keys enabled and a busy timeout. Migrations are versioned and run on startup. Realtime snapshots are retained for 30 days by default. Scraped records are upserted using source identity plus content hash. Successful refreshes update source state; failed refreshes do not erase the last successful data.

For an unavailable source, a service may use cached records if their effective dates still match the request. The response marks their age and stale status. Cache use never suppresses the corresponding warning.

## 7. Corridor Matching

`config/corridors.json` is editable and validated at startup. Each corridor contains:

- A stable ID and display name.
- BSAG/VBN route IDs and public line names.
- Stop, street, district, venue, and place aliases.
- Optional aliases for common spelling and punctuation variants.

Matching is deterministic and case-insensitive after Unicode, whitespace, and punctuation normalization. Exact line/route matches rank above phrase-boundary place matches. Substring matches inside unrelated words are prohibited. Each matched impact records the aliases that caused the match.

The first version ships a clearly documented starter mapping for central, east, west, north, and south Bremen. Because static GTFS route shapes are out of scope, corridor overlap is evidence-based text matching, not a geometric intersection. Briefs must say so when this distinction matters.

## 8. Tool Contracts

Every tool returns an MCP text content block containing readable English and a structured JSON content block where supported by the SDK. The JSON payload follows this envelope:

```ts
interface ToolResponse<T> {
  generated_at: string;
  timezone: 'Europe/Berlin';
  status: 'complete' | 'partial';
  data: T;
  sources: Array<{
    source: string;
    fetched_at?: string;
    age_seconds?: number;
    stale: boolean;
  }>;
  warnings: SourceWarning[];
}
```

Invalid caller input is an MCP tool error. Upstream source problems are successful tool responses with `status: "partial"` and warnings.

### `get_line_health`

Input:

```ts
{
  line_ids: string[]; // 1–100 unique, non-empty IDs
  at_time?: string;   // ISO 8601; defaults to now
}
```

Without `at_time`, the service refreshes realtime data subject to a 60-second minimum refresh interval. With `at_time`, it selects the latest snapshot at or before the requested instant. If no preceding snapshot exists within 15 minutes, the line is returned with unavailable metrics and a warning; it does not silently substitute a later observation.

VBN GTFS-Realtime observations are keyed by static GTFS `routeId` values. A configurable route map translates public BSAG line labels such as `6` or `10` to the route IDs used by the realtime feed. When a caller supplies a public label that is not directly present in the feed and no mapping is configured, the service returns unavailable metrics with `ROUTE_MAPPING_UNAVAILABLE` rather than treating the line as disruption-free or unobserved.

For each trip update, the representative delay is the latest usable stop-time delay, falling back to the trip-level delay when present. Metrics include observed trips, updates with usable delay, coverage, mean/median/p95 delay, maximum delay, and percentage on time. The default on-time threshold is delay no greater than 300 seconds; early trips remain on time unless earlier than the configurable early-running threshold. Unsupported GTFS-RT fields are omitted rather than invented.

### `get_external_impacts`

Input:

```ts
{
  corridors?: string[];
  date_from: string; // ISO date or datetime
  date_to: string;   // ISO date or datetime, inclusive; <= 31 days after date_from
}
```

The service fetches relevant VMZ and Bremen event sources concurrently, filters by effective interval overlap, applies corridor matching, deduplicates equivalent impacts, and sorts by start time then severity. Unknown corridor IDs are input errors.

### `get_service_notices`

Input:

```ts
{
  line_ids?: string[];
  stop_names?: string[];
  since?: string; // ISO date or datetime; defaults to seven days ago
}
```

The service combines BSAG and VBN notices. A notice qualifies when it is published since the cutoff, remains effective since the cutoff, or has no reliable publication date but was fetched since the cutoff. Line and stop filters are ORed within each field and ANDed between non-empty fields. With no filters, all qualifying notices are returned, capped by a configurable limit.

### `build_shift_brief`

Input:

```ts
{
  date: string; // YYYY-MM-DD in Europe/Berlin
  corridors?: string[];
  include_comms_draft?: boolean; // defaults false
}
```

The shift window is 06:00–10:00 Europe/Berlin. Corridor configuration determines candidate lines. If no corridors are supplied, all configured BSAG corridors and their lines are evaluated. The service obtains the latest realtime baseline, notices effective for the shift, and external impacts overlapping the shift. It computes line and corridor risks, highlights evidence overlaps, lists source limitations, and optionally drafts messages for high or severe risks. The brief never claims that current realtime delay is a forecast; it labels it as a current or recent baseline.

### `draft_passenger_information`

Input:

```ts
{
  line_ids: string[];
  issue_summary: string; // 1–2,000 characters
  channel: "app" | "web" | "stop";
}
```

Templates are deterministic and English-only. The app version targets 240 characters, the stop display targets 160 characters, and the web version may include a short heading and two concise paragraphs. If shortening would remove essential line or impact information, the response warns that manual editing is required. Drafts use cautious language for assessed risk and direct language only for confirmed notices supplied by the caller.

## 9. Explainable Risk Model

Risk scores are operational prioritization aids. They are additive, capped at 100, and include every contribution in the response. Default contributions are configuration:

- Realtime delay severity: 0–30 points from median and p95 delay.
- On-time performance: 0–15 points below configured thresholds.
- Feed quality: 0–5 uncertainty points for low but non-zero coverage; zero observations produce an unknown assessment rather than artificial risk.
- Matching active service notices: 0–25 points based on explicit disruption terms and affected lines/stops.
- Matching roadworks/detours/traffic alerts: 0–20 points based on date overlap, severity hints, and corridor-match confidence.
- Matching major events: 0–10 points based on venue/corridor match and available scale hints.
- Multi-source overlap: 0–10 points when independent evidence types affect the same line/corridor and shift.

Bands are `low` (0–24), `moderate` (25–49), `high` (50–74), and `severe` (75–100). Missing sources reduce confidence and produce warnings; they do not automatically lower the score to imply safety. The response includes `confidence: low | medium | high` based on source availability, freshness, and match quality.

## 10. Error Handling and Observability

Warning codes include `SOURCE_TIMEOUT`, `SOURCE_HTTP_ERROR`, `SOURCE_TOO_LARGE`, `UNEXPECTED_CONTENT_TYPE`, `PARSE_FAILED`, `PARSER_NO_RECORDS`, `STALE_CACHE_USED`, `NO_SNAPSHOT_IN_RANGE`, `LOW_REALTIME_COVERAGE`, `MISSING_EFFECTIVE_DATE`, and `TRUNCATED_RESULT`.

Logs are structured JSON on stderr for stdio safety. They include request/tool correlation IDs, source timings, record counts, cache decisions, warning codes, and errors without full scraped content. The HTTP transport exposes `/health/live` and `/health/ready`; readiness confirms configuration and database availability but does not require every external source to be online.

Process-level failures use non-zero exit codes. Tool handlers catch expected source and domain errors so one malformed source cannot crash the server.

## 11. Security

- Tool inputs cannot override source URLs, preventing server-side request forgery.
- Source redirects are limited and may only remain on configured hosts unless explicitly allow-listed.
- HTTP binds to `127.0.0.1` by default. Binding to a non-loopback address requires `BSAG_MCP_BEARER_TOKEN`.
- Bearer-token comparison uses constant-time comparison. Secrets are never logged.
- Request body sizes and concurrent MCP sessions are bounded.
- HTML, XML, and PDF data are untrusted input and never interpreted as executable code.
- Production containers run as a non-root user with a writable data directory only.

## 12. Testing and Quality Gates

Vitest is used for unit and integration tests. Checked-in, minimized fixtures cover every parser. Tests include:

- GTFS-Realtime JSON normalization and malformed/partial entities.
- VBN and BSAG notice extraction, line/stop matching, and parser drift detection.
- VMZ RSS, HTML, PDF-link discovery, and PDF text normalization.
- Bremen event extraction and incomplete event records.
- Europe/Berlin date boundaries and daylight-saving transitions.
- Snapshot selection, retention, deduplication, and stale-cache behavior.
- Corridor matching false-positive cases.
- Every risk contribution, cap, band, confidence rule, and missing-source behavior.
- Channel-specific communications length and wording.
- Partial-success integration scenarios with mocked HTTP and temporary SQLite.
- MCP contract tests over stdio and Streamable HTTP.

Normal CI is deterministic and performs formatting checks, ESLint, strict TypeScript checking, tests with coverage, production build, and dependency audit. Live-source smoke tests are separate and opt-in because public sites change and may be unavailable.

Coverage thresholds start at 90% statements/lines/functions and 85% branches for `domain`, `services`, and parser modules. No production implementation is accepted without a failing test first and passing relevant tests afterward.

## 13. Packaging and Operation

The package provides:

- `bsag-mcp` for stdio.
- `bsag-mcp-http` for Streamable HTTP.
- npm scripts for development, migration, testing, build, lint, formatting, and opt-in live smoke checks.
- A multi-stage Dockerfile, `.env.example`, MCP client configuration examples, and operations documentation.

Startup validates all configuration and corridor mappings before accepting requests. The data directory is configurable and created only by the runtime startup path, not by importing modules. Graceful shutdown stops new HTTP requests, closes MCP sessions, waits briefly for active refreshes, and closes SQLite.

## 14. Acceptance Criteria

The implementation is complete when:

1. All five tools are discoverable and callable over both transports with validated schemas.
2. Realtime fixtures produce correct per-line health metrics and persisted historical snapshots.
3. Notice, traffic, roadwork, and event fixtures normalize into provenance-bearing records.
4. A source outage returns useful partial data and an explicit structured warning.
5. `build_shift_brief` produces a 06:00–10:00 English brief with ranked, explained risks and labelled realtime baseline evidence.
6. Corridor overlap reports the exact configured aliases that matched.
7. Optional communications drafts obey channel constraints or identify required manual editing.
8. HTTP exposure rules, health endpoints, input limits, and redirect restrictions are tested.
9. Formatting, linting, strict type checking, tests, coverage thresholds, and production build pass.
10. Documentation explains configuration, data limitations, transport setup, source attribution, and live-smoke operation.
