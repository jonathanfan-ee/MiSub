# Fixed IPv4 subscription collector

Development package only. Installing it, creating credentials, applying production
SQL, merging the PR, and enabling sources each require the operator's approval.
No real airport URL, credential, server address, or production database is included.

## Operation

One Python 3.9+ standard-library program runs once per minute under systemd. It
claims at most one assigned source, negotiates native Clash YAML and universal
URI text, then posts both results to the existing Pages site over HTTPS. The VM
does not expose a listener. Source URLs are maintained only in MiSub.

- Only direct IPv4 TLS is used, for both MiSub and upstream. Proxy environment
  variables are ignored. Public IPv4 addresses are resolved once and pinned for
  the connection; the original hostname remains the TLS verification identity.
- Every redirect is revalidated. HTTP, embedded URL credentials, private/reserved
  destinations, and non-443 ports are rejected. At most three redirects follow
  the initial request. Certificates are verified.
- The absolute 10-second upstream deadline includes DNS, headers and body.
  Each response is limited to 512 KiB. Compressed bodies are rejected; requests
  explicitly ask for identity encoding. MiSub API requests have a 5-second deadline.
- The two format requests run concurrently. A persisted, shared budget admits
  at most four upstream HTTP attempts per rolling 60 seconds, INCLUDING redirect
  attempts and failures. MiSub control requests do not count as airport requests.
  Corrupt rate state stops requests rather than resetting the budget.
- A process lock prevents overlapping runs. There are no immediate HTTP retries.
  Next attempts are scheduled by MiSub: normally five minutes after completion,
  at least five minutes after failure. The one-minute poll can add up to a minute
  before a due source starts; sources sharing one collector may be staggered.
  A 429 Retry-After can extend that delay.
- HTTP 401/403 or a recognized explicit suspension message pauses the source.
  An administrator must resolve the provider issue and select "恢复采集并排队".
  Normal refresh does not unpause it. Unknown invalid content preserves the last
  valid snapshot and reports an error without claiming to diagnose a ban.

## Configuration to review before deployment

The site needs a **Pages secret** named `MISUB_COLLECTORS`. The sample below is
documentation, not a valid credential (REPLACE placeholders are rejected):

```json
{
  "dmit-us": {
    "secret": "REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS",
    "expectedIpv4": "203.0.113.10"
  }
}
```

Register the VM's verified outbound IPv4, not an assumed DNS result or a proxy
exit. MiSub verifies the Cloudflare-provided CF-Connecting-IP against this
registration. Keep one active machine for each collector identity. Moving the
collector or changing the VM IP needs a controlled registration update.

The VM reads `/etc/misub-collector/config.json` (owner `misub-collector`, mode
0600); see `config.example.json`. It contains only the MiSub URL, collector ID,
and matching secret. The collector can claim only enabled fixed-egress sources
whose saved `collectorId` matches its ID, and can only upload their leased cache
results. It receives no profile list, site settings, admin password, or Cloudflare
API token. The browser receives collector IDs/IPs and status, never these secrets.

Proposed installation layout:

| Item | Location / ownership |
| --- | --- |
| Program | `/opt/misub-collector/misub_collector.py`, root-owned, read-only to service |
| Service account | `misub-collector`, no interactive shell |
| Configuration | `/etc/misub-collector/config.json`, service-owned, 0600; directory 0700 |
| State | `/var/lib/misub-collector`, 0700; only rate history and process lock |
| Service/timer | `systemd/misub-collector.service` and `.timer` copied to `/etc/systemd/system` |
| Log | systemd journal; fixed result/error codes only, no URLs or bodies |

`python3 -B /opt/misub-collector/misub_collector.py --check` validates local
configuration without network access. Service installation/enabling commands
are deliberately not run by the development workflow.

## MiSub source fields and API

Use D1 and review/apply **both** additive migrations, in order:
`migrations/0001_subscription_cache.sql`, then `0002_collector_jobs.sql`.
The second adds `collector_jobs` and short-lived `collector_nonces`. No runtime
DDL is performed. The full `schema.sql` includes both for fresh installations.

Fixed source fields:

```json
{
  "fetchPolicy": "cache-first",
  "refreshVia": "collector",
  "collectorId": "dmit-us",
  "realtimeFetch": false
}
```

Save the source before refreshing. One upstream URL must occur only once in the
source list; subscription groups can share that source. Changing its URL,
assignment or enabled state fences old jobs. Leases expire after 30 seconds;
the normal job budget is below 20 seconds (claim + concurrent fetch + result).
Abandoned jobs become eligible after the five-minute cooldown.

Machine API, both POST:

| Endpoint | Result |
| --- | --- |
| `/api/collector/tasks` | Zero or one source task, URL, URL hash and short-lived lease |
| `/api/collector/results` | Validates both formats again and atomically publishes snapshots/job status |

Headers: `X-Collector-Id`, `X-Collector-Timestamp` (epoch milliseconds),
`X-Collector-Nonce`, `X-Collector-Signature` (hex HMAC-SHA256). Sign this UTF-8 text:

```text
POST\n<path>\n<collector-id>\n<timestamp>\n<nonce>\n<hex SHA256 of exact request body>
```

Time skew is limited to five minutes. A D1 nonce record rejects replay. Source
configuration and the current lease are checked again inside the publication
transaction. Both valid formats can update independently; invalid content never
replaces the respective previous successful payload or traffic metadata.

Admin-cookie-only endpoints `/api/collector_refresh` and `/api/collector_status`
enqueue/resume jobs and read metadata; they do not contact airports. Status polling
runs only while a visible card is queued/collecting and stops when it finishes.

## First pilot and rollback

1. Read-only preflight after approval: verify the selected DMIT VM, actual IPv4
   egress, clock synchronization, Python/CA certificates, and deployment paths.
   Do not contact a suspended airport to perform infrastructure preflight.
2. After deployment approval, back up site data and settings, apply the reviewed
   migrations, deploy the reviewed commit, and register the single collector.
   Shared `main` builds both Pages sites; keep the customer site unconfigured/off.
3. Start with automatic collection off (`sourceCacheEnabled: false`). Assign only
   the pilot ASH source to the collector and save. Explicit admin refresh can queue
   one prewarm while automatic collection is off. Wait for the provider's update
   suspension to clear before making this first controlled request.
4. Verify both saved snapshots, TLS/ShadowTLS/hosts, traffic metadata, the source IP
   in provider records, and actual client node connections. Until a usable snapshot
   exists, affected aggregate updates return HTTP 503, preserving imported client
   configurations rather than exporting an empty node list. Coordinate the short
   initial update window, or seed from a separately verified valid backup first.
5. Only after acceptance, enable automatic collection on the personal site.
   Client accesses and repeated refresh clicks never cause Pages to pull a fixed
   source. A normal request returns the cached snapshot; refresh clicks queue work.

Rollback: disable automatic collection and stop the VM timer. Keep `refreshVia`
as `collector`; existing matching snapshots continue to serve with access/expiry
checks on every client request. Snapshot/table failures return HTTP 503. Do not
silently switch this source back to Pages realtime. The old inline cache fields
and new additive tables are retained. A code rollback should be assessed separately;
`realtimeFetch:false` also limits accidental direct reads by older aggregation code.

Provider aggregation/sharing permissions and node connectivity require their own
acceptance; fixed egress does not remove provider limits or establish node health.

## Local verification

`npm test` runs JS/Miniflare D1 tests, a real Python-to-JS local API integration,
and Python standard-library unit tests. Network fixtures use loopback test-only
transports. Production transport tests cover IPv4 pinning, TLS identity, private
destination rejection, redirects, deadlines and persistent rate limiting. No
real airport credentials are used.

References: [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/),
[Python HTTPSConnection](https://docs.python.org/3/library/http.client.html),
[systemd timers](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html).
