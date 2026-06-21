# BSAG Public Operations Briefing MCP Server

TypeScript MCP server for BSAG operations briefings. It combines public VBN GTFS-Realtime, BSAG/VBN notice pages, VMZ Bremen traffic information, and Bremen event listings into five explainable tools:

- `get_line_health`
- `get_external_impacts`
- `get_service_notices`
- `build_shift_brief`
- `draft_passenger_information`

Every tool returns a full structured envelope with `status: "complete" | "partial"`, source freshness, and explicit warnings when a public source is stale, unavailable, or only partially parsed.

## Requirements

- Node 22
- npm
- Optional: Docker

## Install and build

```bash
npm ci
npm run build
```

## Run over stdio

```bash
cp .env.example .env
node --env-file=.env dist/transports/stdio.js
```

Example client configuration:

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

## Run over Streamable HTTP

Loopback-only startup:

```bash
node --env-file=.env dist/transports/http.js
```

Non-loopback startup requires a bearer token:

```bash
HTTP_HOST=0.0.0.0 HTTP_PORT=3000 HTTP_BEARER_TOKEN=change-me node --env-file=.env dist/transports/http.js
```

HTTP rules:

- loopback hosts (`127.0.0.1`, `localhost`, `::1`) can run without a bearer token
- non-loopback hosts must set `HTTP_BEARER_TOKEN`
- requests with an `Origin` header are rejected unless the exact origin or hostname matches the configured allowlist
- `/health/live` returns process liveness
- `/health/ready` returns database readiness

## Environment variables

Key runtime variables:

- `BSAG_MCP_DATA_DIR`: writable directory for SQLite storage; the server stores `bsag.sqlite` inside it
- `CORRIDORS_PATH`: corridor mapping JSON, default packaged `config/corridors.json` beside the installed binaries
- `LINE_ROUTE_MAP_PATH`: public line label to GTFS route ID mapping JSON, default packaged `config/line-route-map.json`
- `HTTP_HOST`: bind host for HTTP mode, default `127.0.0.1`
- `HTTP_PORT`: bind port for HTTP mode, default `3000`
- `HTTP_BEARER_TOKEN`: required when `HTTP_HOST` is not loopback
- `HTTP_ALLOWED_ORIGINS`: comma-separated allowed exact origins or hostnames
- `RETENTION_DAYS`: SQLite retention for realtime snapshots, default `30`
- `REALTIME_REFRESH_INTERVAL_SECONDS`: GTFS-Realtime reuse window, default `60`

The server does not auto-load `.env`; use Node's `--env-file` flag or export variables in the shell.

Public source URLs are also configurable; see [.env.example](.env.example).

## Corridor editing

Corridors are editable in [config/corridors.json](config/corridors.json). The file maps public line IDs and conservative place-name aliases. It does not claim geometric route overlap.

Line route mappings are editable in [config/line-route-map.json](config/line-route-map.json). The file translates public labels such as `6` or `10` to the static GTFS route IDs used by the VBN GTFS-Realtime feed. Direct GTFS route IDs are still accepted.

## SQLite retention

Realtime snapshots are stored in SQLite. Old snapshots are pruned according to `RETENTION_DAYS`. Service notices and external impacts are replaced per source refresh and reused as stale cache when a refresh fails.

## Tool examples and test prompts

The examples below are phrased as natural-language prompts for an MCP-capable
assistant, followed by the tool payload that should be sent. The Bremen details
were selected from public web sources checked on 2026-06-21, so refresh the
dates if the upstream notices have expired:

- BSAG [Linien- und Fahrpläne](https://www.bsag.de/fahrplan/linien-und-fahrplaene)
  and [Tagesnetz PDF](https://www.bsag.de/fileadmin/user_upload/26-04-13_Tagesnetz_WEB_.pdf)
  for Bremen line and stop names such as Hauptbahnhof, Domsheide, Flughafen,
  Universität-Nord, Gröpelingen, and Sebaldsbrück
- VBN
  [Verkehrshinweise für den Bus- und Straßenbahnverkehr](https://www.vbn.de/vbn/verkehrshinweise/bus-und-strassenbahnverkehr)
  for current public construction and diversion notices
- VMZ Bremen [Baustellen aktuell](https://vmz.bremen.de/baustellen/aktuell)
  and [RSS traffic feed](https://vmz.bremen.de/verkehrslage/aktuell/feed.rss)
  for roadwork and traffic-impact checks
- Bremen.de
  [Veranstaltungskalender](https://www.bremen.de/kultur/veranstaltungen) and
  [Veranstaltungs-Highlights](https://www.bremen.de/kultur/veranstaltungen/highlights)
  for event-driven checks

The bundled route map translates common BSAG public line labels to the static
GTFS `routeId` values used by VBN GTFS-Realtime. If a caller supplies an
unmapped public label, the tool returns `ROUTE_MAPPING_UNAVAILABLE` instead of
inferring a disruption or a clean line. Direct GTFS route IDs are still accepted.

### `get_line_health`

1. Prompt: Check current realtime health for BSAG lines 6 and 10; use the
   public line numbers, not internal GTFS route IDs.

   ```json
   { "line_ids": ["6", "10"] }
   ```

2. Prompt: Compare the central Bremen tram lines visible around Hauptbahnhof
   and Domsheide on the BSAG Tagesnetz: 1, 4, 6, and 8.

   ```json
   { "line_ids": ["1", "4", "6", "8"] }
   ```

3. Prompt: Look up the stored morning baseline for line 20 on 2026-06-21 at
   08:00 Berlin time, because VBN lists Steffensweg works affecting line 20.

   ```json
   { "line_ids": ["20"], "at_time": "2026-06-21T08:00:00+02:00" }
   ```

### `get_external_impacts`

1. Prompt: For 2026-06-21, list external VMZ and event impacts on the east
   corridor around Hemelingen, Sebaldsbrück, and Weserpark.

   ```json
   { "corridors": ["east"], "date_from": "2026-06-21", "date_to": "2026-06-21" }
   ```

2. Prompt: Check the west corridor from 2026-06-21 through 2026-06-28, including
   Walle, Gröpelingen, and Steffensweg-related impacts.

   ```json
   { "corridors": ["west"], "date_from": "2026-06-21", "date_to": "2026-06-28" }
   ```

3. Prompt: Find city-centre and north-side external impacts for the Bremen
   Tag der Deutschen Einheit event weekend, 2026-10-02 to 2026-10-04.

   ```json
   {
     "corridors": ["central", "north"],
     "date_from": "2026-10-02",
     "date_to": "2026-10-04"
   }
   ```

### `get_service_notices`

1. Prompt: Show notices since 2026-06-15 for BSAG lines 1 and N1; VBN lists
   night replacement buses for track works between Kurt-Huber-Straße and
   Nußhorn.

   ```json
   { "line_ids": ["1", "N1"], "since": "2026-06-15T00:00:00+02:00" }
   ```

2. Prompt: Show service notices for line 2 since 2026-06-08, covering the
   VBN-listed Gleisbauarbeiten and Zeppelintunnel/Sebaldsbrück changes.

   ```json
   { "line_ids": ["2"], "since": "2026-06-08T00:00:00+02:00" }
   ```

3. Prompt: Find notices touching Universität-Nord and Bf Sebaldsbrück, two
   stop names present in the BSAG network material and current VBN notices.

   ```json
   {
     "stop_names": ["Universität-Nord", "Bf Sebaldsbrück"],
     "since": "2026-04-01T00:00:00+02:00"
   }
   ```

### `build_shift_brief`

1. Prompt: Build the east-corridor morning brief for 2026-06-22 and include
   passenger drafts, because VBN lists Zeppelintunnel and Steubenstraße works
   around Sebaldsbrück and Hemelingen.

   ```json
   {
     "date": "2026-06-22",
     "corridors": ["east"],
     "include_comms_draft": true
   }
   ```

2. Prompt: Build the west-corridor shift brief for 2026-06-22 without comms,
   checking Walle, Gröpelingen, and VBN's Steffensweg line-20 notice.

   ```json
   {
     "date": "2026-06-22",
     "corridors": ["west"],
     "include_comms_draft": false
   }
   ```

3. Prompt: Build a central and north Bremen brief for 2026-10-03 with comms
   drafts for the Tag der Deutschen Einheit event weekend referenced by
   Bremen.de.

   ```json
   {
     "date": "2026-10-03",
     "corridors": ["central", "north"],
     "include_comms_draft": true
   }
   ```

### `draft_passenger_information`

This tool does not fetch sources itself; pass it an `issue_summary` copied from
or summarized from the public source you want to turn into passenger copy.

1. Prompt: Draft an app update for line 2 passengers: VBN says line 2 is
   diverted from 8 to 29 June 2026 because of track work; Lloydstraße and
   Doventor are not served and Doventorsteinweg is served instead.

   ```json
   {
     "line_ids": ["2"],
     "issue_summary": "From 8 June 2026, 03:00, to 29 June 2026, 03:00, line 2 is diverted between Hansator and Radio Bremen via Haferkamp (platform A) and Doventorsteinweg because of track work. Lloydstraße and Doventor are not served; Doventorsteinweg is additionally served.",
     "channel": "app"
   }
   ```

2. Prompt: Draft web copy for lines 21, 23, 31, and N3: VBN lists Achterstraße
   works from 13 April to December 2026, with line 31 split and stops including
   Universität-Nord not served.

   ```json
   {
     "line_ids": ["21", "23", "31", "N3"],
     "issue_summary": "Because of construction work in Achterstraße from 13 April 2026 until expected December 2026, lines 21, 23, 31, and N3 are diverted. Line 31 is split; stops including Helmer, Berufsbildungswerk, Lise-Meitner-Straße, Universität/Zentralbereich, Universität-Nord, and Linzer Straße are not served on affected trips.",
     "channel": "web"
   }
   ```

3. Prompt: Draft a stop-display note for line 20: VBN lists Kanal- und
   Straßenbauarbeiten in Steffensweg from 12 August 2024 to expected mid-2026,
   with a Nordstraße diversion and several stops not served.

   ```json
   {
     "line_ids": ["20"],
     "issue_summary": "Because of sewer and road construction in Steffensweg from 12 August 2024 until expected mid-2026, line 20 is diverted in both directions between Lange Reihe and Konsul-Smidt-Straße via Nordstraße. Bremervörder Straße, Karl-Peters-Straße, Sankt-Magnus-Straße, and Johann-Bornemacher-Straße are not served.",
     "channel": "stop"
   }
   ```

## Partial-result semantics

All public sources are unstable. The server does not hide that instability:

- `status: "complete"` means no source warnings were attached
- `status: "partial"` means at least one warning was attached
- `sources` reports freshness and staleness by source
- `warnings` reports machine-readable source problems such as timeouts, stale-cache fallback, parser drift, or truncated results

## Risk and attribution limitations

- corridor matching is alias-based, not geographic
- risk scoring is explainable but heuristic
- realtime coverage depends on public GTFS-Realtime availability
- notices and events rely on HTML structure that may change without notice

Official public sources used by this server:

- VBN GTFS-Realtime and notice pages
- BSAG Aktuelles / operational notices
- VMZ Bremen RSS and roadworks pages
- Bremen event listings

## Live smoke checks

The live suite is opt-in and never runs in normal CI:

```bash
npm run test:live
```

It fetches the configured official source URLs and only asserts transport/parser invariants. It prints per-source status without logging response bodies.

## Troubleshooting parser warnings

Common warning patterns:

- `SOURCE_REFRESH_FAILED`: the source did not refresh and stale cache may be in use
- `PARSER_NO_RECORDS`: the page structure changed or no operational records matched
- `MISSING_EFFECTIVE_DATE`: the source content omitted a usable date window
- `PDF_EXTRACT_FAILED`: VMZ PDF content could not be extracted

If warnings persist, verify the live source HTML or feed structure before changing the parser.

More deployment and operations detail lives in [docs/operations.md](docs/operations.md).
