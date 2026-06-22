# Operations guide

## Runtime modes

The server supports:

- stdio for local MCP client integration
- stateless Streamable HTTP for hosted deployments

Both modes use the same SQLite database and the same five MCP tools.

## Security

- loopback HTTP can run without bearer auth
- non-loopback HTTP requires `HTTP_BEARER_TOKEN`
- origin-bearing requests are filtered against exact configured origins or allowed hostnames
- only `/data` should be writable in container deployments

## Data layout

- `BSAG_MCP_DATA_DIR=/path/to/dir` stores `bsag.sqlite`
- `CORRIDORS_PATH` points at the editable corridor mapping
- `LINE_ROUTE_MAP_PATH` points at the editable public line to GTFS route ID mapping
- realtime retention is controlled by `RETENTION_DAYS`

## Recommended startup

Local stdio:

```bash
npm run build
node --env-file=.env dist/transports/stdio.js
```

Hosted HTTP on loopback:

```bash
node --env-file=.env dist/transports/http.js
```

Hosted HTTP behind a reverse proxy:

```bash
HTTP_HOST=0.0.0.0 HTTP_PORT=3000 HTTP_BEARER_TOKEN=change-me node --env-file=.env dist/transports/http.js
```

## Docker

Build:

```bash
docker build -t bsag-briefing-mcp:test .
```

Run stdio:

```bash
docker run --rm -i -v "$(pwd)/data:/data" bsag-briefing-mcp:test node dist/transports/stdio.js
```

Run HTTP. The image defaults to Streamable HTTP, binds to `0.0.0.0`, and uses `HTTP_PORT`, `PORT`, or `3000` in that order:

```bash
docker run --rm -p 3000:3000 -e HTTP_PORT=3000 -e HTTP_BEARER_TOKEN=change-me -v "$(pwd)/data:/data" bsag-briefing-mcp:test
```

Cloud Run:

```bash
gcloud run deploy bsag-briefing-mcp --source . --set-env-vars HTTP_BEARER_TOKEN=change-me
```

## CI

The repository CI workflow runs:

- `npm ci`
- `npm run check`
- `npm audit --omit=dev --audit-level=high`

Live source smoke checks are intentionally excluded from normal CI.

## Live source smoke execution

```bash
npm run test:live
```

Expected outcome:

- sources either return records or structured warning codes
- parser drift is surfaced as warnings
- no source body content is printed

## Troubleshooting

- 401 on HTTP mode: missing or invalid bearer token
- 403 on HTTP mode: origin rejected by host/origin policy
- repeated `SOURCE_REFRESH_FAILED`: upstream outage or stale source URL
- repeated `PARSER_NO_RECORDS`: page structure drift or non-operational content
- `MISSING_SOURCE_FRESHNESS` in shift briefs: one or more upstream feeds were stale or unavailable

## Attribution

This server depends on public information published by:

- VBN / Connect
- BSAG
- VMZ Bremen / ASV Bremen
- bremen.de

Keep source URLs accurate in your exported environment or `--env-file` input and respect the upstream sites’ availability and operational constraints.
