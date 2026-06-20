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
node dist/transports/stdio.js
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
HTTP_HOST=127.0.0.1 HTTP_PORT=3000 node dist/transports/http.js
```

Non-loopback startup requires a bearer token:

```bash
HTTP_HOST=0.0.0.0 HTTP_PORT=3000 HTTP_BEARER_TOKEN=change-me node dist/transports/http.js
```

HTTP rules:

- loopback hosts (`127.0.0.1`, `localhost`, `::1`) can run without a bearer token
- non-loopback hosts must set `HTTP_BEARER_TOKEN`
- requests with an `Origin` header are rejected unless the origin matches the configured host or `HTTP_ALLOWED_ORIGINS`
- `/health/live` returns process liveness
- `/health/ready` returns database readiness

## Environment variables

Key runtime variables:

- `BSAG_MCP_DATA_DIR`: writable directory for SQLite storage; the server stores `bsag.sqlite` inside it
- `CORRIDORS_PATH`: corridor mapping JSON, default `./config/corridors.json`
- `HTTP_HOST`: bind host for HTTP mode, default `127.0.0.1`
- `HTTP_PORT`: bind port for HTTP mode, default `3000`
- `HTTP_BEARER_TOKEN`: required when `HTTP_HOST` is not loopback
- `HTTP_ALLOWED_ORIGINS`: comma-separated allowed origins or hostnames
- `RETENTION_DAYS`: SQLite retention for realtime snapshots, default `30`
- `REALTIME_REFRESH_INTERVAL_SECONDS`: GTFS-Realtime reuse window, default `60`

Public source URLs are also configurable; see [.env.example](.env.example).

## Corridor editing

Corridors are editable in [config/corridors.json](/home/nasimpcm/Desktop/BSAG-MCP/.worktrees/bsag-briefing-server/config/corridors.json). The file maps public line IDs and conservative place-name aliases. It does not claim geometric route overlap.

## SQLite retention

Realtime snapshots are stored in SQLite. Old snapshots are pruned according to `RETENTION_DAYS`. Service notices and external impacts are replaced per source refresh and reused as stale cache when a refresh fails.

## Tool examples

`get_line_health`

```json
{ "line_ids": ["10", "25"] }
```

`get_external_impacts`

```json
{ "corridors": ["east"], "date_from": "2026-06-21", "date_to": "2026-06-21" }
```

`get_service_notices`

```json
{ "line_ids": ["10"], "since": "2026-06-20T00:00:00Z" }
```

`build_shift_brief`

```json
{ "date": "2026-06-21", "corridors": ["east"], "include_comms_draft": true }
```

`draft_passenger_information`

```json
{
  "line_ids": ["10"],
  "issue_summary": "Roadworks may affect the eastern corridor tomorrow morning.",
  "channel": "app"
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

More deployment and operations detail lives in [docs/operations.md](/home/nasimpcm/Desktop/BSAG-MCP/.worktrees/bsag-briefing-server/docs/operations.md).
