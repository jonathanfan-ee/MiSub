# Airport source snapshots (opt-in)

When a client fetches an aggregate subscription, realtime mode fetches upstream
again. An upstream timeout, error page, or format negotiation can make nodes
disappear. Cache-first mode stores the last validated upstream responses in D1,
then generates each client's configuration after its normal authorization checks.

## Configuration

| Setting | Default / behavior |
| --- | --- |
| `sourceCacheEnabled` | `false`, stored independently per site |
| Source `fetchPolicy` | `legacy`; select `cache-first` only for chosen sources |
| Existing `realtimeFetch` | Existing realtime / inline-cache-only meanings retained |
| Fresh interval | 30 minutes |
| Request timeout | 10 seconds, including the response body |
| Retry interval | At least 5 minutes after the preceding refresh completes, also enforced for dashboard refreshes |
| Source refresh lease | 30 seconds, shared across both formats |
| Warning age | 24 hours; last successful snapshot remains usable |

No scheduler is installed. An authorized subscription access after the fresh
interval returns the saved snapshot immediately and schedules a refresh with
Pages `context.waitUntil`. A cold request waits for the first snapshot. Concurrent
requests share a D1 lease. A failed format never replaces that format's last
successful payload; a successful sibling format can still update independently.
Manual refresh obeys the same source lock and cooldown.

Native Clash YAML and universal URI text occupy separate rows. Native snapshots
retain the original YAML, including ShadowTLS, TLS, and endpoint hosts aliases.
Only the existing native-proxy importer selects what goes into the final config;
airport DNS, rules, and groups do not override the administrator's template.
If an airport only supplies URI text, direct Clash output can use the separately
validated universal snapshot without pretending it is a native YAML snapshot.

Changing the URL changes its SHA-256 identity immediately. Prior URL snapshots
are not served for the new URL. Refresh tokens fence late writes. Background
refreshes only write `subscription_cache`, never the whole subscriptions list.
Enabled/expiry/token checks remain ahead of all source-cache access; there is no
shared cache of final user configurations.

## Database and rollout (requires operator approval)

1. Back up the selected site's D1 data and settings. Verify its database/project
   identity; the personal and customer Pages sites have independent bindings.
2. Review and manually apply `migrations/0001_subscription_cache.sql` to the
   selected D1. It only creates a new table and can be applied repeatedly. There
   is no runtime auto-migration. Initial installs include it in `schema.sql`.
3. Merge/deploy only after approval. A shared Git branch may deploy BOTH Pages
   sites, but the default flag is off, so neither uses the new table yet.
4. Personal site pilot: enable `sourceCacheEnabled` in settings, then choose
   cache-first on each specifically approved airport source and save. Leave
   S-UI sources on their existing modes. Keep the customer site flag off.
5. Refresh once, inspect separate format counts/success/error/age in the cards,
   and validate the exported client configuration and actual node connections.
   Cache correctness does not establish node connectivity.

If the table is missing, enabling the setting is rejected. If D1 cache access
fails after enabling, subscription reads fall back to the legacy fetch path;
the dashboard reports cache storage unavailable. A source without a successful
snapshot can still be absent while its upstream is failing.

Rollback: disable `sourceCacheEnabled` for that site. Sources return to their
existing `realtimeFetch` behavior. Inline `cachedRaw` fields are retained. Keep
the additive cache table for diagnosis; deleting it is unnecessary for rollback.
Re-enabling a source uses matching-URL snapshots and freshness checks as usual.

## ASH: source-IP limits are an additional rollout gate

The operator's 2026-10-31 notification states a maximum of 10 subscription-fetch
source IPs in 24 hours and 5 fetches per minute. Exceeding the limit suspends
subscription updates for 24 hours; the notice says previously imported nodes
continue to work. One refresh negotiates two formats, so it makes two requests.

Cloudflare Pages does not provide a stable, single outbound IP for these fetches.
Caching reduces request frequency but CANNOT guarantee the 10-IP limit. Do not
enable an ASH pilot on the assumption that cache-first alone resolves this limit.
Likewise, realtime fallback during cache-storage failure can issue more requests.

Before enabling ASH, review its subscription-fetch records, confirm permitted
aggregation/sharing terms, and separately approve a stable-egress fetch design.
That design and any server, network, scheduler, or production setting changes
are outside this PR. Do not use repeated live fetches to test a suspended source.
All regression fixtures in this PR are synthetic and contain no provider tokens.

References: [Pages EventContext](https://developers.cloudflare.com/pages/functions/api-reference/#eventcontext),
[D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[Cloudflare default function placement](https://developers.cloudflare.com/workers/configuration/placement/).
