# Data Source Verification

## Current standalone implementation note

This document retains dated provider evidence, source conventions and unresolved documentation conflicts. Current scanner behavior is in [SCANNER.md](SCANNER.md). Payout v2's gross-or-proven-net exact-feed policy is an implementation inference, not a published StonkFun fee convention.

Primary documentation checked for the v2 extension: [Solana SDK IDs](https://github.com/anza-xyz/solana-sdk/blob/master/sdk-ids/src/lib.rs), [compute-budget interface source](https://docs.rs/solana-compute-budget-interface/latest/src/solana_compute_budget_interface/lib.rs.html), and [Solana transfer-fee semantics](https://solana.com/docs/tokens/extensions/transfer-fees). [Node SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) and a local Node 24.18.0 compatibility check support the built-in driver. These documentation reads do not establish live payout accuracy.

Verified: **2026-09-20 UTC**

Current implementation guidance updated: **2026-09-21 UTC**. History loads in layers (updated 2026-09-24): a first scan fetches the last 7 days before its cutoff, a refresh the loaded range to its cutoff, and Load earlier 7-day batches back to the fixed floor, 2026-08-01T00:00:00Z (2026-09-01 until 2026-09-24); seven-day request examples and the live probe below remain dated historical evidence. Current implementation details are in [SCANNER.md](SCANNER.md).

This document records the first Phase 1 research pass. It is based on current official documentation, unauthenticated read-only StonkFun API responses, small read-only Solana public-RPC checks of signatures published by StonkFun, and one bounded authenticated Helius capability probe. The Helius key and raw authenticated response were not retained.

Live counts below are snapshots, not constants. StonkFun launch counts changed during this research session.

## Decision summary

1. Use the paginated StonkFun launch ledger, `GET /launches?mode=reward`, as the broad reward-launch source. Union its quote mints with the payout-bearing summaries from `GET /rewards`. Use `GET /pairs` only for enrichment; it is not a historical allowlist.
2. Use Helius `getTransactionsForAddress` on the wallet owner with `tokenAccounts: "balanceChanged"`, a bounded `blockTime` range, `status: "succeeded"`, incoming token-transfer filtering, and full parsed transactions. Follow `paginationToken` until it is `null`.
3. Confirm a payout only from an exact official-feed signature or a full transaction matching an evidence-backed, recently refreshed payout pattern. A supported quote mint, an incoming transfer, or a batch shape is not enough.
4. Treat StonkFun's published `withdrawWithheldAuthority` as a Token-2022 withdrawal role, not as a universal payout identity. It was a transfer authority in some sampled official payouts and absent from other sampled official payouts.
5. For current USD value, try StonkFun's quote pricing first and Helius DAS second. StonkFun does not document that this endpoint is the source used by its rewards page, so that ordering is an implementation inference, not proven price-source equivalence. Neither source guarantees every custom, retired, or illiquid mint. Missing prices remain missing; they are never converted to zero.

## Official sources

### StonkFun

- [Developer documentation](https://www.stonkfun.xyz/developers)
- [OpenAPI document](https://www.stonkfun.xyz/api/public/v1/openapi.json)
- [Reward launch ledger](https://www.stonkfun.xyz/api/public/v1/launches?mode=reward&pageSize=100&page=1)
- [Reward-token catalogue](https://www.stonkfun.xyz/api/public/v1/tokens?mode=reward&pageSize=100&page=1)
- [Pair catalogue](https://www.stonkfun.xyz/api/public/v1/pairs)
- [Rewards overview and recent distribution feed](https://www.stonkfun.xyz/api/public/v1/rewards?limit=100)
- [LaunchLab pricing/configuration](https://www.stonkfun.xyz/api/public/v1/launchlab/pricing?quoteMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
- Per-token reads: `/tokens/{mint}`, `/tokens/{mint}/rewards`, `/tokens/{mint}/fees`, and `/tokens/{mint}/airdrop`

### Helius and Solana

- [Helius `getTransactionsForAddress` guide](https://www.helius.dev/docs/rpc/gettransactionsforaddress)
- [Helius `getTransactionsForAddress` API reference](https://www.helius.dev/docs/api-reference/rpc/http/gettransactionsforaddress)
- [Helius historical-data coverage](https://www.helius.dev/docs/rpc/historical-data)
- [Helius token-account history announcement](https://www.helius.dev/blog/solana-token-accounts-history)
- [Helius `getTransfersByAddress` guide](https://www.helius.dev/docs/rpc/gettransfersbyaddress)
- [Helius `getTransfersByAddress` API reference](https://www.helius.dev/docs/api-reference/rpc/http/gettransfersbyaddress)
- [Helius Wallet History](https://www.helius.dev/docs/wallet-api/history)
- [Helius Wallet Transfers](https://www.helius.dev/docs/wallet-api/transfers)
- [Helius Enhanced Transactions address history](https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactionsbyaddress)
- [Older `getTransactionsForAddress` launch article](https://www.helius.dev/blog/introducing-gettransactionsforaddress)
- [Helius credits](https://www.helius.dev/docs/billing/credits)
- [Helius plans](https://www.helius.dev/docs/billing/plans)
- [Helius rate limits](https://www.helius.dev/docs/billing/rate-limits)
- [Helius consolidated billing reference](https://www.helius.dev/docs/billing/llms.txt)
- [Helius consolidated RPC reference](https://www.helius.dev/docs/api-reference/rpc/http/llms.txt)
- [Solana transaction JSON structures](https://solana.com/docs/rpc/json-structures)
- [Solana `getTransaction`](https://solana.com/docs/rpc/http/gettransaction)
- [Solana `getSignaturesForAddress`](https://solana.com/docs/rpc/http/getsignaturesforaddress)
- [Solana `getTokenAccountsByOwner`](https://solana.com/docs/rpc/http/gettokenaccountsbyowner)

### Pricing

- [Helius `getAsset`](https://www.helius.dev/docs/api-reference/das/getasset)
- [Helius `getAssetBatch`](https://www.helius.dev/docs/api-reference/das/getassetbatch)
- [Helius fungible-token extension](https://www.helius.dev/docs/das/fungible-token-extension)
- [Helius DAS price coverage FAQ](https://www.helius.dev/docs/faqs/das-api)
- [Jupiter Price API V3](https://developers.jup.ag/docs/price/index)
- [Jupiter token-pricing guide](https://developers.jup.ag/docs/guides/how-to-get-token-price)
- [Jupiter pricing and rate limits](https://developers.jup.ag/pricing)

## 1. Reward-launch and quote-asset discovery

### Confirmed endpoint roles

| Endpoint | Role | Important observed fields | Coverage finding |
| --- | --- | --- | --- |
| `GET /launches?mode=reward&pageSize=100&page=N` | Primary reward-launch ledger | `mint`, `pool`, `creator`, `quote.{mint,symbol}`, `launchpad`, `mode`, optional `transferFee.bps`, `createdAt`, `pagination` | Broadest official enumeration tested. Snapshot at `2026-09-20T22:14:55Z`: 68,665 rows across 687 pages. |
| `GET /rewards?limit=100` | Payout-bearing launch summaries plus latest distribution rows | `launches[].quote.{mint,symbol,decimals}`, raw distributed amount, payout/holder counts; `recentDistributions[]` evidence | Snapshot at `2026-09-20T22:13:03Z`: 21,117 launch summaries, 384 unique quote mints, and 100 recent rows. It is not the complete launch ledger. |
| `GET /pairs` without `launchable=true` | Current quote identity/configuration enrichment | `mint`, `symbol`, `name`, `decimals`, `category`, `tokenProgram`, `launchable`, `launchLabReady` | 521 rows in the observed snapshot. All returned rows had `launchable: true`, but five quote mints represented in payout summaries were absent. This endpoint cannot be a historical allowlist. |
| `GET /tokens?mode=reward&pageSize=100&page=N` | Optional live token/status/market enrichment | token and pool identity, quote metadata, status, market data, transfer-fee and flywheel fields, pagination | Snapshot: 68,175 rows, fewer than the launch ledger. The reason for every difference is not documented. |
| `GET /tokens/{mint}/rewards` | Per-launch reward aggregates | `mint`, `mode`, `quote`, exact distributed/undistributed/queued/in-flight/stranded raw amounts, payout/holder counts | Useful for targeted enrichment, not global discovery. Confirmed aggregates-only on 2026-09-22 (section 11): no distribution rows or signatures. |

Sanitized launch-ledger shape:

```json
{
  "data": {
    "launches": [
      {
        "mint": "<launch-mint>",
        "quote": { "mint": "<quote-mint>", "symbol": "<symbol>" },
        "launchpad": "launchlab",
        "mode": "reward",
        "transferFee": { "bps": 100 },
        "createdAt": "2026-09-20T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 100,
      "total": 68665,
      "totalPages": 687
    }
  },
  "meta": { "generatedAt": "2026-09-20T22:14:55.471Z" }
}
```

Sanitized rewards shape:

```json
{
  "data": {
    "launches": [
      {
        "mint": "<launch-mint>",
        "quote": { "mint": "<quote-mint>", "symbol": "<symbol>", "decimals": 6 },
        "distributedRaw": "123456789",
        "payoutCount": 42,
        "holderCount": 17,
        "lastPayoutAt": "2026-09-20T00:00:00.000Z"
      }
    ],
    "recentDistributions": [
      {
        "signature": "<signature>",
        "mint": "<launch-mint>",
        "quoteMint": "<quote-mint>",
        "amountRaw": "123456",
        "holderCount": 8,
        "distributedAt": "2026-09-20T00:00:00.000Z"
      }
    ]
  }
}
```

### Recommended discovery procedure

1. Paginate `/launches?mode=reward&pageSize=100` and deduplicate by launch mint.
2. Retain every `quote.mint`; mint, never symbol, is the identity.
3. Fetch `/rewards?limit=100` once and union every summarized `quote.mint`. During this research, its payout summaries identified five quote mints absent from the current `/pairs` catalogue.
4. Enrich the union from `/pairs` without `launchable=true`. Never drop a mint because pair metadata is absent.
5. Use `/tokens` or per-token endpoints only when extra live/status/decimal metadata is needed.
6. Record each response's `meta.generatedAt` and the scanner's retrieval time.

This discovers the current official launch ledger plus quote mints retained in payout summaries. It does **not** prove that an absent pair is retired or non-launchable, or that StonkFun permanently retains lifetime history; no such SLA is documented.

### Pagination and limit behavior

- `/launches` and `/tokens` document `pageSize` 1–100, default 25. Live requests silently clamped `pageSize=101` to 100, `page=0` to 1, and a page beyond the end to the last page.
- A paginator must stop when returned `pagination.page >= pagination.totalPages`. Waiting for an empty page can loop forever because an oversized page number returned the last page again.
- Page-based results are mutable. Reward-launch totals increased during a several-minute test. Dedupe by stable identity, record generation times, and perform a bounded catch-up pass using `/launches?since=...` or a page-one refetch. There is no snapshot cursor, so an atomic full crawl is not guaranteed.
- `/rewards` has no page, cursor, or `since` parameter. Its `limit` controls only `recentDistributions`; it does not reduce or paginate the large `launches` array. Values above 100 were clamped to 100.
- In observed traffic, the latest 100 distribution rows covered only roughly 33–79 seconds. They cannot serve as a seven-day wallet ledger.
- Multiple recent rows can share one signature because one transaction can aggregate distributions for multiple launch mints.
- `/pairs` has no pagination and no documented historical-retention guarantee. A live `/pairs?launchable=false` request did not reveal a non-launchable archive: all 521 returned records still declared `launchable: true` (three had `launchLabReady: false`). A `launchable=true` request returned fewer rows despite those exposed flags. The filter's live semantics are therefore unresolved and must not be used to exclude quotes.
- StonkFun documents 300 ordinary reads per minute per IP. Successful responses exposed `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; the API advertises `Retry-After` for `429` responses. A roughly 687-page initial crawl must be throttled and resumable.

## 2. Evidence for actual holder payouts

### Confirmed findings

The strongest available StonkFun evidence is an exact `recentDistributions.signature` together with its launch mint, quote mint, raw amount, holder count, and timestamp.

Small public-RPC spot checks of feed-backed signatures found:

- successful transactions;
- repeated `transferChecked` instructions from a common quote-token source to recipient token accounts;
- recipients did not sign;
- exact raw transfer sums matched the sum of `amountRaw` across all feed rows sharing the signature (and matched the row itself for single-row signatures);
- single-recipient and multi-recipient payouts both occurred;
- sampled payout-only transactions had no swap/DEX leg; and
- a transaction containing two feed rows could consolidate an overlapping recipient, so summed feed `holderCount` did not necessarily equal instruction count.

Therefore, group feed rows by signature before reconciling the full transaction. Fetch and count each transaction/balance delta once, while preserving all launch rows attached to that signature.

### Minimum confirmation evidence

A candidate should be confirmed only when all applicable evidence agrees:

- transaction succeeded;
- searched wallet owns the receiving token account;
- exact raw pre/post balance delta is positive and equals the amount counted;
- mint is in the official reward-launch quote universe;
- searched wallet did not sign the transaction;
- exact signature is in the current official feed, or signer/source/structure matches an authority pattern derived from feed-backed transactions with retained evidence;
- transaction structure is payout-compatible and has no reciprocal swap/purchase, creator-claim, LP, mint, burn, or unrelated protocol flow; and
- duplicate feed rows/signatures/instructions cannot make the same wallet delta count twice.

Batching is corroborating evidence, not a requirement. A verified single-recipient payout was observed.

### Creator fees, ordinary transfers, swaps, and airdrops

- `GET /tokens/{mint}/fees` is creator-fee state, not holder-payout history. Observed fields were `mint`, `creator`, `claimable`, and `reason`; standard launches can expose claimable base/quote amounts and claim endpoints. In observed reward-mode responses, legacy reward launches described trading fees as paid to holders, while v3 reward launches described transfer tax as paid to holders and trading fees as going to the platform. Both returned `claimable: null` for the creator.
- The documented creator-claim flow requires the creator wallet's participation/signature. Full transaction evidence must still be checked; the API does not provide a historical list of creator-claim signatures.
- An ordinary transfer can use a valid StonkFun quote mint and can be unsigned by the recipient. Mint plus direction is therefore insufficient.
- A swap or purchase normally includes the searched wallet as signer, an outgoing leg, and DEX/aggregator instructions. These are exclusion signals, not a substitute for positive payout identity.
- Airdrop metadata has a separate per-token endpoint. A base/launch-token receipt is not a quote-asset holder reward, but mint alone must not be the only exclusion test.
- Any payout-like transaction lacking sufficient identity evidence remains an `unknownCandidate` and is excluded from confirmed totals.

## 3. Withdrawal authority versus payout authority

`GET /launchlab/pricing` currently exposes:

```json
{
  "data": {
    "modes": {
      "reward": {
        "transferFeeBps": [100, 300],
        "withdrawWithheldAuthority": "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD"
      }
    }
  }
}
```

The field name and developer documentation describe authority to withdraw Token-2022 withheld transfer fees. That role is not definitionally the authority that later transfers quote assets to recipients.

Observed official-feed transactions showed both cases:

- In signature `2DgAYNqBK2KaTANrZQbfiMiiqpq5w9L9VcCE2jd4uTKKwFdBX2KfgPtBFd5a4VrbKA568z2fGQ3ngBgvJ5RUdGhK`, the published withdrawal authority was a signer and the transfer authority for the payout's wrapped-SOL quote transfers. The official feed row observed on 2026-09-20 named launch mint `CY6xRXqZ6nuRzL5ZNp15zUMn8kue42C8NASJrPpiCzSu`, quote mint `So11111111111111111111111111111111111111112`, raw amount `665543524`, and 12 holders. Because the feed is rolling, this row may no longer be retrievable there.
- In signature `2upAAMX4MnmyAwXQLZxvFEr4SYP7T9DNdPLGCWbGyr6oJssMWaQNGPABmyvEqedLKeAa4omBtHpPsJgQvJDS2oW9`, the official feed row named launch mint `2DMHdbvTgGDmNqtiMn9yvEPU4txcba5KHqVbkcbtVUPm`, quote mint `5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ`, raw amount `108302`, eight holders, and distribution time `2026-09-20T22:07:11.275Z`. Its eight quote transfers summed to `108302`. The signer and transfer authority was `HuBMeYW3aDn8BH65fo8xxbP4oiexyup8udzKyccgi8Ga`; the published withdrawal authority was absent from the transaction account keys.

Conclusion: the published withdrawal authority is **sometimes observed in payout execution but is not interchangeable with a universal payout authority**. It is candidate evidence only. The other observed signer is likewise not documented as permanent and must not be hardcoded without its supporting signatures and observation window.

A future registry entry should retain authority, observed role, launch mechanism, supporting signatures, source account/mint, and first/last verification timestamps. It must refresh from the current official feed before classification.

## 4. Helius wallet-history methods

### Recommended primary method: `getTransactionsForAddress`

The current API reference supports:

- `transactionDetails`: `signatures` or `full`;
- `encoding`: including `jsonParsed` for full transactions;
- `maxSupportedTransactionVersion: 1` for legacy, v0, and v1 transactions;
- `commitment`: `confirmed` or `finalized`, not `processed`;
- `sortOrder`: `asc` or `desc`;
- limit 1–1,000 for both signatures and full modes;
- filters for slot, Unix `blockTime`, signature, status, token-account expansion, and token transfers;
- token-transfer direction, one optional mint, counterparty, and raw amount comparisons; and
- opaque cursor pagination through `result.paginationToken`.

Top-level filters are combined with logical AND. Because the token-transfer filter accepts only one mint, the first implementation should request all incoming token transfers in the time window and apply the discovered quote-mint set locally rather than issue one wallet-history crawl per mint.

`tokenAccounts` behavior:

- `none` (default): address must be directly referenced;
- `balanceChanged` (recommended): also includes transactions that change a token account owned by the wallet; and
- `all`: also includes transactions merely referencing an owned token account.

The owner-expansion feature depends on owner metadata introduced at slot `111,491,819` (approximately December 2022). That boundary does not affect a current rolling-seven-day scan, but it prevents an unconditional lifetime-history claim.

Sanitized request shape:

```json
{
  "jsonrpc": "2.0",
  "id": "scan",
  "method": "getTransactionsForAddress",
  "params": [
    "<wallet-address>",
    {
      "transactionDetails": "full",
      "encoding": "jsonParsed",
      "maxSupportedTransactionVersion": 1,
      "commitment": "finalized",
      "sortOrder": "asc",
      "limit": 100,
      "filters": {
        "blockTime": { "gte": 1789728000, "lte": 1790332800 },
        "status": "succeeded",
        "tokenAccounts": "balanceChanged",
        "tokenTransfer": { "direction": "in" }
      }
    }
  ]
}
```

These illustrative timestamps preserve the historical seven-day request example, including its inclusive `lte` endpoint. The implemented planner targets the last 7 days before the cutoff on a first scan, the loaded range to the cutoff on a refresh, and 7-day batches back to the 2026-08-01T00:00:00Z floor on Load earlier, in chunks of at most one day, each mapped to RPC `gte` at its start and `lte` one second before its end. The example does not validate durable coverage or reporting; see [SCANNER.md](SCANNER.md).

Sanitized response evidence:

```json
{
  "result": {
    "data": [
      {
        "slot": 123456789,
        "transactionIndex": 42,
        "blockTime": 1790000000,
        "transaction": {
          "signatures": ["<signature>"],
          "message": { "accountKeys": [], "instructions": [] }
        },
        "meta": {
          "err": null,
          "preTokenBalances": [
            {
              "accountIndex": 5,
              "mint": "<mint>",
              "owner": "<wallet-address>",
              "programId": "<token-program>",
              "uiTokenAmount": { "amount": "1000000", "decimals": 6 }
            }
          ],
          "postTokenBalances": [
            {
              "accountIndex": 5,
              "mint": "<mint>",
              "owner": "<wallet-address>",
              "programId": "<token-program>",
              "uiTokenAmount": { "amount": "1123456", "decimals": 6 }
            }
          ],
          "innerInstructions": [],
          "logMessages": []
        }
      }
    ],
    "paginationToken": "<opaque-cursor-or-null>"
  }
}
```

Repeat the same bounded request with each returned token until `paginationToken` is `null`. Preserve raw amount strings and inspect both outer and inner instructions.

Current billing documentation says signatures-only responses cost 10 credits flat and full responses cost 10 credits per 100 returned transactions, rounded up with a 10-credit minimum. A 1,000-record full page can therefore cost 100 credits. Failed API responses are documented as free.

The current guide describes unlimited retention on mainnet, two weeks on devnet, and no testnet support. It also lists a small set of program/reserved addresses that use legacy archival behavior, slot-scan fallback, or return no data. Those special-address exceptions do not describe an ordinary user wallet, but they prevent a universal-address coverage guarantee.

### Other methods

| Method | Token-account coverage and filters | Pagination, access, and limits | Suitability |
| --- | --- | --- | --- |
| `getTransfersByAddress` | Expands an owner wallet to parsed token transfers. Supports `with`, `direction`, one `mint`, `solMode`, raw `amount`, `blockTime`, and `slot` comparisons, plus `commitment`, `minContextSlot`, and sort order. | Up to 100; follow opaque `paginationToken` values until `null`; Developer plan or higher; 10 credits/request. V1 omits failed transactions, hidden SOL balance movements, collapsed intermediary flows, and `harvestWithheldTokensToMint`; owner addresses cannot be batched. | Useful candidate feed with exact raw amounts and transfer types, but hydrate signatures with `getTransaction` for signer and instruction proof. |
| Wallet History beta, `GET /v1/wallet/{address}/history` | `tokenAccounts=none|balanceChanged|all`, default `balanceChanged`; `after` and parsed `type` filters. The same pre-slot-`111,491,819` owner-history caveat applies. | Up to 100; while `pagination.hasMore`, pass `pagination.nextCursor` as `before`; 100 credits/request; current plan table lists Wallet API on all standard tiers. | Human-readable `balanceChanges.amount` is a JSON number rather than an exact raw integer, so this should not be the primary accounting source. |
| Wallet Transfers beta, `GET /v1/wallet/{address}/transfers` | The documented server-side request filters are only `limit` and `cursor`; no owner-token-account expansion setting is documented. | Default 50, maximum 100; while `pagination.hasMore`, pass `pagination.nextCursor` as `cursor`; 100 credits/request; current plan table lists Wallet API on all standard tiers. | Includes exact `amountRaw`, but lacks full signer/instruction evidence and documented owner-expansion semantics. It cannot establish completeness or payout identity alone. |
| Enhanced Transactions address history | Supports `token-accounts=none|balanceChanged|all`, before/after signatures, timestamp/slot bounds, `source`, `type`, sort order, and commitment. | 1–100 with manual before/after-signature pagination; 100 credits/request. The current plan table lists Enhanced APIs on Free/Developer/Business/Professional at 2/10/50/100 requests per second. | Parsed labels such as swap/transfer are corroboration, not payout proof. This is a legacy/maintenance API. |
| Standard `getSignaturesForAddress` + `getTransaction` | No automatic owner-token-account expansion. Signature lookup offers `before`, `until`, and commitment, but no time, status, mint, or token-owner filter. | 1–1,000 signatures/page with manual signature cursors; both methods cost 1 credit/call. Current standard RPC limits are 10/50/200/500 requests per second on Free/Developer/Business/Professional. | Owner-only lookup misses ATA-only activity. Enumerating only current accounts with `getTokenAccountsByOwner` can also miss closed or formerly owned accounts. Do not silently downgrade to this path. |

### Helius plan blocker

The current rendered gTFA guide, API page, and credit page specify limits and metering but do not clearly state a minimum plan. The current official consolidated billing and RPC references explicitly label `getTransactionsForAddress` as Developer-plan-or-higher, consistent with an older official launch article's paid-plan statement. This is a documentation-presentation conflict, not evidence that Free includes the method.

The implementation must perform a safe capability probe with each user's key and surface an actionable plan/feature error. A successful probe with one key confirms only that key's entitlement at that time; it does not establish Free-plan availability.

### Live BYO-key capability probe

A bounded probe was run against mainnet on `2026-09-20T23:04:22Z`. The process loaded `HELIUS_API_KEY` from the ignored repository-local `.env`; it did not print or persist the key, authenticated URL, raw response, signatures, or account addresses from the response.

Probe request:

- wallet: one wallet with StonkFun payouts (its address is not recorded);
- fixed cutoff: `2026-09-20T23:04:22Z`;
- fixed start: `2026-09-13T23:04:22Z`;
- duration: exactly `604800` seconds (168 hours);
- `transactionDetails: "full"`, `encoding: "jsonParsed"`, `maxSupportedTransactionVersion: 1`;
- `commitment: "finalized"`, `sortOrder: "asc"`, and `limit: 5`;
- `blockTime` bounded with `gte` and `lte`, `status: "succeeded"`, `tokenAccounts: "balanceChanged"`, and incoming `tokenTransfer` direction; and
- at most four total attempts, with only one additional page permitted.

Sanitized result:

| Observation | Result |
| --- | --- |
| Key-specific method access | Supported at verification time; both requests returned HTTP 200 with a JSON-RPC `result`. |
| Requests and retries | 2 requests, 0 retries. |
| Page 1 | 5 full transactions; `paginationToken` present. |
| Page 2 | 5 full transactions; `paginationToken` present and different from page 1. No third page was requested. |
| Result envelope | `result.data` array plus `result.paginationToken`. |
| Full item shape | `slot`, `transactionIndex`, `blockTime`, `version`, `transaction`, and `meta`. |
| Transaction evidence | `transaction.signatures`; message account keys, address-table lookups, instructions, and recent blockhash. |
| Metadata evidence | status/error, fee and balances, pre/post token balances, inner instructions, logs, compute/cost units, and rewards. |

The returned block times were inside the recorded window and increased across the two ascending pages. The distinct second-page token confirms that this key accepted cursor continuation for this request shape. It does not establish free-plan entitlement, exhaust the seven-day window, validate reward classification, or guarantee complete wallet/reward coverage.

The probe harness classified failures without emitting provider messages: HTTP 401 or explicit missing/invalid/revoked-key signals as `authentication`; explicit plan/upgrade/feature-access signals as `entitlement`; HTTP 400 or JSON-RPC `-32602` as `invalid_parameter`; and timeouts, network failures, HTTP 408/425/429, or 5xx responses as retryable `transient` failures. JSON-RPC `-32601` should be reported as method/routing unavailability unless the sanitized provider semantics explicitly identify plan access. No error category occurred in this probe.

The method-specific reference documents `maxSupportedTransactionVersion: 1`, and the live probe accepted it. The consolidated RPC summary currently says `0`; implementation should follow the method-specific reference and retain a regression test because the official summaries conflict.

## 5. Current USD pricing

### Provider order

| Source | Confirmed capability | Important limit | Recommendation |
| --- | --- | --- | --- |
| StonkFun `GET /launchlab/pricing?quoteMint=...` | Public, mint-keyed `prices.quoteUsd` and `prices.observedAt`; representative current categories priced successfully | One mint/request; 300 ordinary reads/minute/IP; config/registration dependent; observed failures included `404 not_found` and retryable `503 service_unavailable`; upstream methodology is undisclosed | First attempt because it is StonkFun-native, but equivalence to the rewards-page price is unproven. Do not treat it as complete. |
| Helius DAS `getAsset`/`getAssetBatch` with fungible data | `token_info.price_info` includes `currency` and `price_per_token`; batch accepts up to 1,000 IDs | Helius documents prices for the top 10,000 tokens by 24-hour volume; price may be absent and can be cached up to 600 seconds; no provider observation timestamp is documented. Current DAS limits are 2/10/50/100 requests per second on Free/Developer/Business/Professional. A batch can error when one or more assets are not found. | Fallback using the already-required Helius key. Preserve and validate `currency` rather than silently relabeling it USD; partition a failing batch or retry IDs individually. Record retrieval time and cache limitation. |
| Jupiter Price API V3 | Mint-keyed `usdPrice`, `blockId`, decimals, and optional liquidity; up to 50 mints/request | Omits mints without a reliable/recent price; current only; current guide requires a separate Jupiter API key; Free is currently 1 request/second | Optional later fallback only after approving the extra credential and trust policy. |

StonkFun pricing example:

```json
{
  "data": {
    "quote": {
      "mint": "<quote-mint>",
      "symbol": "USDC",
      "decimals": 6,
      "tokenProgram": "<token-program>"
    },
    "prices": {
      "solUsd": 110.33,
      "quoteUsd": 0.99975,
      "observedAt": "2026-09-20T22:11:57.432Z"
    }
  }
}
```

`/pairs` itself has no price. Live tests showed that some quote mints absent from `/pairs` still priced successfully, while others returned `not_found` or a retryable service error. Pair membership must not gate a pricing attempt.

No reviewed source guarantees every xStock, PreStock, currency, commodity, collectible, leverage asset, custom pair, retired pair, or future category. These are all mint-address lookups; symbols and categories must not select or synthesize prices. A stablecoin must not be hardcoded to exactly one dollar.

### Missing-price contract

For each unpriced confirmed reward mint:

- retain mint, raw integer amount, decimals, and exact display amount;
- retain each provider's original HTTP status/code, attempted provider, and retrieval time, plus a normalized reason such as `not_found`, `service_unavailable`, or `price_info_absent`;
- if the implementation uses `no_launchlab_config`, treat it only as an internal normalized reason derived from independently observed `launchLabReady: false`; it is not a published provider error code and must not be inferred by parsing changeable message text;
- exclude it from `pricedConfirmedTotalUsd` without substituting zero;
- list it prominently in human-readable and JSON output;
- define a priceable payout as one confirmed wallet-credit record keyed by signature and mint, then report priced records versus total records and priced mints versus total mints; and
- state that the USD total, rolling seven-day average, latest-24-hour total, and every per-day USD total cover priced rewards only.

Do not report a USD-value coverage percentage when missing prices make the denominator unknowable. For priced results, retain provider, provider field, provider observation time when available, scanner retrieval time, and freshness caveat.

## 6. Context-file conflicts and clarifications

1. **Launch discovery:** the context treats `/rewards` summaries as the main universe source. Live data shows `/rewards` contained only about 21,000 payout-bearing summaries while `/launches?mode=reward` contained about 68,000 reward launches. The launch ledger should be primary and `/rewards` should be unioned into it.
2. **Pair coverage:** the context correctly says not to restrict to `launchable=true`, but even the unfiltered current pair catalogue omitted five mints present in current payout summaries. `/pairs` must be enrichment, never a gate; this observation alone does not establish why those mints are absent.
3. **Authority role:** the context's published v3 authority must be narrowed to its documented `withdrawWithheldAuthority` role. Live payout evidence shows it is not a universal payout signer.
4. **Helius completeness:** the preferred rolling-seven-day gTFA configuration is documented and the pre-December-2022 token-account limitation is irrelevant to that window. An unqualified all-history guarantee would be incorrect, and free-plan entitlement remains unresolved.
5. **Pricing:** StonkFun pricing sometimes accepts mints absent from `/pairs`, despite the pricing parameter being documented as coming from `/pairs`. This useful behavior is undocumented and must not become a coverage promise. Equivalence between LaunchLab pricing and the rewards page's displayed values is also unproven.

These findings were incorporated into canonical context version 1.1 with the user's authorization during the registry-loader build. This research record retains the original evidence and unresolved qualifications; the corrections do not establish atomic/lifetime coverage, permanent payout identities, Free-plan Helius access, or price-source equivalence.

## 7. Confirmed facts versus unresolved assumptions

### Confirmed

- The broad launch ledger is paginated and materially larger than payout summaries.
- The current pair catalogue omits some quote mints represented in payout summaries.
- The recent official distribution feed is capped and far too short for a seven-day scan.
- Feed-backed signatures provide strong payout evidence, and both single-recipient and batched payouts exist.
- Multiple launch rows can share one signature.
- The withdrawal authority is not universally interchangeable with the observed quote payout authority.
- gTFA supports the filters and full transaction evidence required for a current seven-day scan.
- No reviewed pricing source guarantees all reward mints.

### Unresolved

- StonkFun exposes no pageable historical distribution-signature feed; the per-launch endpoint returns aggregates only (section 11). A new installation cannot derive every legacy authority from the current feed.
- Payout signer rotation and permanence are not documented.
- Atomic completeness and lifetime retention of the page-based launch ledger are not guaranteed.
- Historical creator-claim signatures are not exposed by the public StonkFun read API.
- gTFA succeeded with the tested BYO key. Current consolidated official references say Developer+, while rendered method/credit pages omit the minimum-plan label; this success does not demonstrate Free-plan access.
- StonkFun does not disclose the upstream source or methodology for `quoteUsd`.
- StonkFun does not state that LaunchLab `quoteUsd` and the rewards page use the same provider or calculation.
- No provider offers universal current USD coverage for custom, retired, or illiquid quote mints.

Until legacy authority evidence is available, legacy-looking matches without an exact feed signature or verified registry evidence must remain `unknownCandidate`. This blocks a responsible claim of complete seven-day legacy reward coverage, but it does not block implementation of the registry loader, Helius capability probe, or conservative classifier.

## 8. Retrieval evidence limit

Complete transaction retrieval for a range cannot establish complete payout classification: the short official signature feed, absent historical authority ledger and undocumented rotation leave some credits unattributed. The standalone implementation stores retrieved coverage separately from reward confirmation; [SCANNER.md](SCANNER.md) describes its current contract. These are evidence limits, not new provider guarantees.

## 9. Transaction normalization source conventions (2026-09-21 UTC)

On 2026-09-21 UTC, the separately authorized normalization task consulted only [Solana JSON structures](https://solana.com/docs/rpc/json-structures), [transfer-fee documentation](https://solana.com/docs/tokens/extensions/transfer-fees), and the Agave [token parser](https://github.com/anza-xyz/agave/blob/master/transaction-status/src/parse_token.rs) / [transfer-fee parser](https://github.com/anza-xyz/agave/blob/master/transaction-status/src/parse_token/extension/transfer_fee.rs). No live data API request or environment-file read accompanied this work.

- In jsonParsed evidence, resolved lookup addresses are already part of `message.accountKeys`; token-balance indexes refer to that array. Inner instruction group indexes identify outer instructions, while parsed/partially decoded instructions use addresses. Do not append `loadedAddresses` again.
- Token-2022 can use the `spl-token` program label. Validate actual token-program IDs. Agave preserves authority versus multisig authority/signers; explicit `transferCheckedWithFee` fees use `feeAmount.{amount,decimals}`.
- Token-2022 `transferChecked` can withhold a fee even without explicit fee fields. Gross transfer amount is not necessarily the destination's credited amount. Withheld fees are separate from the spendable token balance, and withdrawal authority is not payout identity.

The source observations above inform the implemented normalizer; [NORMALIZATION.md](NORMALIZATION.md) holds its contract. The scanner's versioned storage policy reconciles only optional `transactionIndex` enrichment between provider methods. It retains every original observation and does not relax missing-transfer, ownership, amount, instruction, signature, execution or contradictory-ordering conflicts. Pure identity-v1 grouping remains conservative.

The full contract and implementation-specific limits are in [NORMALIZATION.md](NORMALIZATION.md). Synthetic fixtures verify behavior, not fresh Helius compatibility, complete token-extension support, reward classification, authority verification, or complete historical coverage. No canonical product requirement or external evidence conflict was resolved by implementing this transform; retrieval from the history floor (now 2026-08-01), arbitrary later ranges, and seven-day reporting remain distinct.

## 10. Payout-evidence source limits (2026-09-21 UTC)

The separately authorized pure module in [PAYOUT_EVIDENCE.md](PAYOUT_EVIDENCE.md) reconciles exact official-feed signatures and quote-mint aggregates against full normalized observations. It retains gross instruction totals separately from proven destination credits and feed amounts. The historical equality observed in section 2 does not define fee-bearing `amountRaw` semantics: Token-2022 feed comparisons remain unresolved, including when exact net credits are proven. No new provider research or live data API request was made.

Only supported transfer witnesses supply observed payout roles. Published withdrawal configuration, fee payer, transaction signer, observed source owner, and transfer authority stay separate. The two historical addresses in section 3 remain prose evidence only; neither is a production trust entry or a manufactured captured fixture. Prior observations survive feed omissions; conflicting rows, transaction variants, and missing-transfer observations remain contested instead of being overwritten. Payout block times and retrieval times are separate, with no uninterrupted-validity, revocation, or arbitrary historical/future-payout claim.

The v1 structural policy accepted parsed token transfers and exactly fee-only native balance changes. V2 additionally accepts strictly decoded compute-budget instructions and proven fee-bearing credits with exact official signature/mint attribution, while preserving gross, net and feed amounts separately. This is an implementation inference, not a general StonkFun feed-fee convention. Multiple source origins for one quote mint remain ambiguous. [PAYOUT_EVIDENCE.md](PAYOUT_EVIDENCE.md) and [SCANNER.md](SCANNER.md) hold current behavior. The capped feed and historical authority gap remain unresolved.

## 11. Per-launch aggregates and site-internal feed (2026-09-22 UTC)

Both observations are user-browser reads. The scanner made no request and retains neither response.

### Confirmed `GET /tokens/{mint}/rewards` shape

Observed for launch `4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8` (response `generatedAt` `2026-09-22T03:35:23.726Z`):

| Field | Observed |
| --- | --- |
| `mint` | The requested launch mint |
| `mode` | `reward` |
| `quote` | Quote mint `DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow` |
| `distributedRaw`, `undistributedRaw`, `queuedRaw`, `inFlightRaw`, `strandedRaw` | Raw amounts, each with a token-unit equivalent |
| `payoutCount` | 273353 |
| `holderCount` | 15657 |
| `lastPayoutAt` | `2026-09-22T03:28:00.761Z`, the only payout time |

There are no distribution rows, signatures, recipients or per-payout times. A launch with 273,353 payouts and no listing cannot bracket, attribute or backfill any individual credit. It remains targeted enrichment only.

### Site-internal `GET /api/rewards-overview`: undocumented, do not ingest

`https://www.stonkfun.xyz/api/rewards-overview?limit=25` is an internal site endpoint, outside `/api/public/v1` and absent from the reviewed public documentation. It has no documented stability, retention, pagination or rate-limit contract. It is weaker than `/api/public/v1/rewards`:

- `recent` rows carry `signature` and launch `mint`, but only `quoteSymbol` (a symbol, never an identity), token-unit `amountTokens` and `amountUsd` instead of a raw amount, `holderCount`, and `createdAt` (undocumented semantics, not `distributedAt`). There is no quote mint or recipient. The rows cannot satisfy exact signature, quote-mint and raw-amount reconciliation.
- `leaderboard` (24,179 per-token aggregate entries) and `totals` (`distributionCount` 22771300, `holderCount` 1921498, `tokenCount` 24179, `totalDistributedUsd`, `lastDistributionAt`) are platform aggregates.

The scanner must not ingest this endpoint as payout, quote-membership or pricing evidence. `/api/public/v1/rewards` remains the only supported exact-feed source.

### Conclusion: no per-wallet history exists

As observed through 2026-09-22, no StonkFun source exposes a per-wallet reward history. None of the public endpoints in section 1 is wallet-scoped, the per-launch endpoint returns aggregates only, the site-internal overview is recent-and-aggregate only, and the site's connected-wallet control shows no per-wallet rewards view. The only official per-signature evidence is the capped recent feed, which rolls through 100 rows in roughly 10 to 80 seconds (section 1; 9.8 seconds in the retained 2026-09-21 snapshot). Exact-feed confirmation therefore cannot be backfilled for credits older than the earliest retained feed row, including the saved wallet's 2026-09-11 to 2026-09-21 credits.
