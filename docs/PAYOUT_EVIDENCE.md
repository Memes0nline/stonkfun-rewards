# Official-distribution reconciliation and payout-authority evidence v1

## Standalone extension: opt-in payout-evidence v2 and v3

The original v1 contract below remains available and its historical review artifacts are preserved. `policyVersion: 'payout-evidence-v2'` additionally accepts strictly decoded documented compute-budget instructions and fee-bearing transfers when exact signature/mint feed attribution and every positive net credit reconcile.

**The standalone scanner now selects `policyVersion: 'payout-evidence-v3'`**, which keeps everything v2 accepts and adds exactly two allowances for the recognized associated-token-account creation unit of [NORMALIZATION.md](NORMALIZATION.md):

- **Interpreted structure, not uninterpreted activity.** `uninterpreted_instruction` is exempt at two positions computed from the decoded evidence: the outer instruction of a recognized unit, and that unit's own inner `system createAccount`. This mirrors the existing compute-budget exemption in form — a narrow position set, never a blanket suppression. The program at an unrecognized position, any other `system` instruction type, and an inner `createAccount` belonging to a different outer index are all still uninterpreted activity, and every other `uninterpreted_instruction` still produces `unresolved_normalization` and `uninterpreted_activity`.
- **The recognized rent, and only the recognized rent, explains native movement.** For each recognized unit in the created form, the unit's own `createAccount.lamports` is expected to leave the account it names as `source` and arrive at the account it names as `newAccount`. The per-account-key equality is then required against those adjusted expectations, with no tolerance, no netting across accounts, no rent-exemption table and no assumption that the funder is the fee payer. The fee payer's index may never be the created account, and the idempotent no-op form gets no allowance because it moves no lamports. Any unrelated lamport movement still breaks at least one index, so wrapped-SOL batches, whose destination lamport balances move with their token balances, keep `unexplained_native_movement`.

Gross and net equalities remain separate; universal feed fee semantics are still not established. Gross and net equalities remain separate; universal feed fee semantics are still not established. Unknown instructions and unsupported lifecycle/extension operations stay unresolved. See [SCANNER.md](SCANNER.md) for the source-backed instruction rules, final wallet classifier, narrow same-slot pattern policy, signature-scoped durable storage and contradiction quarantine. Pure reconciliation still does not itself produce wallet reward totals.

The following sections describe v1 behavior unless explicitly stated otherwise. Prior state must match the selected policy version; silently upgrading a retained derived policy is prohibited. SQLite retains underlying evidence and recomputes changed signatures under the scanner's explicit policy.

`reconcilePayoutEvidence` is a pure TypeScript evidence transform exported from `src/index.ts`. It accepts registry distribution observations, full normalized transaction observations, explicit network/provenance, and optional prior input state. It returns JSON-safe comparisons, retained conflict groups, observed payout roles, and updated input state. It never fetches, reads the environment or current time, persists, classifies wallet rewards, calculates reward totals, or uses an authority allowlist.

All fixtures for this module are explicitly synthetic. The historical addresses and signatures in `DATA_SOURCES.md` are research observations, not captured transaction fixtures or production trust entries. This task makes no live data API requests and establishes no fresh provider compatibility.

## Public input and state

```ts
import { reconcilePayoutEvidence } from './src/index.js';
import type {
  Registry, NormalizedTransaction, PayoutEvidenceState, SolanaNetwork,
} from './src/index.js';

function reconcile(
  registry: Registry,
  transactions: NormalizedTransaction[],
  network: SolanaNetwork,
  evidenceId: string,
  retrievedAt: string,
  prior?: PayoutEvidenceState,
) {
  return reconcilePayoutEvidence({
    feeds: [{
      network,
      provenance: { source: 'stonkfun-public-api', evidenceId, retrievedAt },
      distributions: registry.distributions,
      sources: registry.sources,
      withdrawalAuthorities: registry.authorities.withdrawal,
    }],
    transactions,
    ...(prior ? { prior } : {}),
  });
}
```

The input can contain multiple feed snapshots and canonical networks (`mainnet-beta`, `devnet`, `testnet`). Registry source IDs are scoped to their feed snapshot. Feed provenance uses a safe opaque evidence ID, explicit retrieval timestamp, and `stonkfun-public-api` or `fixture` source label. Both transaction and feed cluster labels are caller assertions; they are never guessed from signatures or mint addresses. A signature on another network provides no support.

Feed row/source schemas are revalidated using the existing distribution schema and the loader's relative-endpoint vocabulary. A row must match its containing signature. Every source reference must resolve unambiguously to a successful rewards retrieval before supporting a comparison. Missing, failed, contradictory, or wrong-source provenance remains `feed_provenance_unresolved`. Missing feed generation times stay absent. Unknown extension fields on distribution rows remain exact JSON evidence. Withdrawal configuration remains separate, with `payoutVerification: 'not_provided'`, even if its source reference is incomplete.

Transactions must be complete `normalizeTransaction` outputs. The function re-runs normalization over the retained full snapshot and compares every derived field, independent of object key order, to reject edited credits, identities, flags, or added trust flags. Structural invalidity throws only `Invalid payout evidence input`; errors do not echo input or schema diagnostics. Semantically unresolved evidence produces retained reason codes.

Returned `state` contains only `schemaVersion: 1`, `policyVersion: 'payout-evidence-v1'`, feeds, and normalized transactions. Exact full input repeats (including their provenance) are deduplicated before grouping; a retrieval with new provenance remains a separate observation. It accepts no preverified authority entries or caller-supplied trusted boolean. Every call validates and recomputes support from the retained evidence. Passing `result.state` back is optional in-memory reconciliation, not implemented storage or sync orchestration. Unknown versions are rejected; no migration or adjudication policy exists.

The caller must provide correctly attributed, credential-free provider evidence and retain the whole state to preserve cross-call conflicts. Neither schema validation nor re-normalization authenticates a provider, verifies a Solana signature, establishes finality, or detects an incorrectly attributed cluster. Raw transaction extensions and logs remain available in state, so this module is not a sanitizer for arbitrary secrets hidden in raw evidence. The Helius retrieval layer's existing credential protections remain independent.

## Exact rows, transfers, and comparisons

Reconciliation keys are exact `(network, primary transaction signature)` pairs. Only exact duplicate rows, including extensions and original integer strings, collapse; all source references survive. Distinct launches sharing one signature remain distinct rows. Two nonidentical rows for the same launch/signature are conservatively `conflicting_feed_rows`, even if only holder count, timestamp, leading zeros, or extension metadata differ. There is no row/event ID permitting a reliable choice or additive interpretation. Their mint total is `null`, never the sum of alternatives. New legitimate launches can be retained across feed snapshots; the union must reconcile to the full transaction.

Every comparison identifies its transaction observation, mint, row indexes, and unique transfer identities. Arithmetic uses `bigint` and returns decimal strings. Original row and instruction strings retain leading zeros. Comparisons deliberately expose separate fields:

| Field | Evidence and meaning |
| --- | --- |
| `feedTotalRaw` | Sum of exact distinct, nonconflicting launch rows for this signature and quote mint. |
| `grossInstructionTotalRaw` | Sum of supported transfer instruction amounts for this mint in one full transaction observation. |
| `provenNetCreditTotalRaw` | Sum of per-instruction destination credits only if every selected transfer has a normalization proof; otherwise null. |
| `feedEqualsGross`, `feedEqualsNet` | Independent numeric equalities, or null when a comparison is unavailable. Equality alone is not support. |

These are transaction evidence aggregates, not wallet reward totals. Comparisons for repeated or conflicting transaction observations are alternatives; they must never be added together. A shared signature, repeated retrieval, overlapping recipient, or additional launch row does not create another credit. Different instruction positions remain different individual-credit identities. A contradictory recipient stays in the same identity group.

The historical spot checks establish gross sums matching feed sums for the observed samples. They do not establish a universal definition of `amountRaw`. V1 requires both gross and proven credit reconciliation for classic SPL Token evidence, whose supported transfers have no transfer fee. For **all Token-2022 transfers**, including an observed zero-fee sample, `feed_fee_semantics_unresolved` withholds payout-role support. The gross and net comparisons are still returned independently. Explicit fees or unique balance reconciliation can prove a destination credit without proving whether the feed reports gross or net amounts. No fee percentage or feed semantics are guessed.

Feed holder counts remain row evidence; they are never summed or compared to instruction count. Every supported credit retains associated launch mints by signature and quote mint only. `perLaunchAllocation: 'not_established'` is always explicit, including single-launch cases; amounts are not apportioned among launch rows or recipients. Launch mechanism is unavailable from these inputs unless preserved in original row extensions; it is never inferred from an authority address.

## Narrow structural support policy

An uncontested signature requires successful transaction evidence, resolved feed provenance, no feed/transaction/identity contradictions, supported normalization, and exact mint/amount reconciliation. Every transfer must have a positive proven net credit. Missing owners, balances, decimals, token programs, lifecycle changes, unsupported operations, ambiguous fees, and unexplained token movements withhold support. Full normalization issues remain accessible alongside the payout-specific reasons.

V1 supports only a transaction whose interpreted instructions are parsed token transfers and whose native balance changes exactly equal the reported fee debit on the first message account. Native balances and fee must be safe integers and have a complete account-key mapping; arithmetic still uses bigint. Every other account's lamport balance must remain unchanged. Missing native evidence remains unresolved.

**Any uninterpreted non-token instruction prevents support.** That includes swap/claim/LP wrappers, compute-budget instructions, memos, and account setup that this version has not decoded, even when supported inner token credits reconcile. This intentionally narrow scope can leave real payouts unresolved. No program allowlist or caller trust flag bypasses it. Later expansion needs separately reviewed instruction semantics and fixtures; matching amounts alone cannot justify expansion.

Recipient owners must not sign or participate as source owners, and destination token accounts must not be transfer sources. Reciprocal/self flows are ambiguous. A direct single transfer authority must be a transaction signer. A multisig retains its separate authority and requires all declared instruction signers to appear among transaction signers; this is observed evidence, not independent multisig threshold verification. Multiple source/authority origins for one mint are `ambiguous_attribution` because the feed cannot allocate those origins. Separate mints can reconcile independently, but any unresolved part quarantines the entire signature from uncontested role support.

The searched-wallet flags remain in normalized state. This transform considers all transfers and recipient owners; it does not apply the final searched-wallet detection contract. `classification` is always `not_performed`.

## Observed roles, rotation, and time

An authority pattern is a versioned tuple containing network, transfer authority and kind, declared instruction signers, source token account, observed source owner, mint/program, transaction signers, and fee payer. Only authorities of supported transfer witnesses produce patterns. Other signers, owners, accounts, and withdrawal configuration do not independently become payout authorities. Delegated transfer authority can differ from the observed source owner; fee payer can differ from the transfer authority.

Each pattern retains individual credit variants with instruction identity/position, signature, recipient account/owner, gross and net amounts, credit-proof basis, launch associations, and witnesses. Witness indexes refer to returned state and the signature's reconciliation rows, giving access to full transactions, owner observations, raw instructions, source IDs, provider generation times, feed distribution times, and retrieval provenance. Identical witness variants are deduplicated. Repeated observations with new provenance expand witness references without adding another credit. There is no payout-count or reward-total field.

`firstObservedPayoutTime` and `lastObservedPayoutTime` use transaction block times only. Individual `observedPayoutTimes` retain the actual samples, including contradictory time variants when contested. Missing block time stays null/empty; feed time and retrieval time never replace it. `firstRetrievedAt` and `lastRetrievedAt` cover supporting transaction/feed/source retrievals, normalized to UTC separately. Feed `distributedAt` and source `generatedAt` are retained without assuming either equals chain time.

These fields describe retained witnesses, including contested historical witnesses; they are **not validity bounds or recent verification guarantees**. `validity` is always `observed_transactions_only`. Omission from a later rolling feed never revokes or deletes older evidence. New and coexisting authorities need their own feed-backed witnesses. Prior patterns never support another transaction solely because an address, mint, source account, signer, or batch shape matches. V1 cannot prove arbitrary earlier/future payouts, uninterrupted authority validity, revocation, or a complete authority history.

## Conflicts and historical support

The existing `groupCreditIdentities` is used unchanged over all retained transaction observations. Its present and `missingTransferObservations` indexes refer directly to `result.state.transactions`, including zero-transfer snapshots. Duplicate positions, changed evidence or wallet context, absent transfers, and later exact repeats follow the existing conservative policy. A separate transaction-level fingerprint also preserves contradictions when every alternative has zero supported transfers and therefore creates no identity group.

The current reconciliation compares the complete retained row union and every transaction observation. Historical support witnesses are also rechecked against each individual feed snapshot and transaction variant. A previously matching witness remains reviewable if newer evidence contradicts it, but its observation becomes `contested` and its signature is `unresolved`. No alternative is selected as the winner. A pattern can have supported, contested, or mixed observations across different signatures. Consumers must examine individual observation status; a mixed pattern is not a blanket trusted address.

The scanner's separate historical-authority model v1 consumes only independently supported exact-feed observations from this reconciler. It creates conservative, strictly interior intervals between consecutive matching witnessed payouts (no more than one day apart), requires both boundary witnesses to share the candidate's complete payout roles including fee payer and signers, and requires retained reward-quote membership evidence. Any appearance of the searched wallet in transaction account keys blocks historical inference. Conflicting or contested timestamped witnesses, overlapping epochs and local safety revocation also block it. This is an explicit scanner inference with per-credit provenance, not a validity claim produced by the pure reconciler or a StonkFun-published authority history. Unwitnessed boundaries remain unknown; evidence in another SQLite database is never silently merged. The offline investigation and exact retained witness signatures are in `review/historical-payout-diagnostic.md` in the review package.

The scanner's distributor-pattern tier (classifier v3, [SCANNER.md](SCANNER.md#evidence-and-classification)) consumes the same reconciler output and produces a separate `attributed` status, never a confirmation. It trusts two kinds of evidence:

- A single-authority witness paying from its own derived account, which makes that identity feed-witnessed across quote mints and time.
- Withdraw-authority configuration snapshots retained in SQLite. Configuration still verifies no payout. It only supports this weaker, separately reported claim, under the snapshot-timeline rule.

Contested or mixed witnesses and contradicted official rows (`conflicting_*`, `missing_transfer_observation`, `mint_mismatch`, `amount_mismatch`) mark the identity conflicted.

Repeats cannot clear conflicts. An omitted feed row alone is not a contradiction because the feed is capped. A changed same-launch row, additional rows that break full-transaction reconciliation, a changed snapshot, or a missing transfer remains unresolved across future calls carrying the retained state. There is no conflict deletion, last-write-wins update, or automatic enrichment merge. Source validity and deliberate caller deletion of prior evidence cannot be established by this pure function.

## Reasons, limits, and verification

Reason codes distinguish missing official rows/transactions, failed transactions, feed provenance/row conflicts, transaction/identity conflicts, missing transfer observations, absent transfers, unresolved normalization, uninterpreted or native activity, mint/amount mismatches, fee semantics, unproven credits, ambiguous attribution, recipient participation, and unsupported authority patterns. Comparisons and full snapshots remain reviewable even when no role witness qualifies.

Synthetic tests cover direct and batched payouts, overlapping launch recipients, exact duplicates, distinct positions, conflicting rows, large exact amounts, mint separation, fees, role separation/multisig, changing/coexisting authorities, omission and observation times, repeated retrievals, historical conflicts, missing/failed transactions, missing transfers in both orders and after repeats, zero-transfer conflicts, wallet contexts, unrelated activity, network/signature isolation, provenance, invalid input, purity, and JSON round trips. A fixture-driven test passes actual registry-loader output into reconciliation. `pnpm test` runs them.

State retains full evidence in memory and grows with unique observations; this version supplies no pruning, retention bounds, serialization service, persistence, or concurrent sync policy. It establishes no historical completeness from the short official feed and no live compatibility guarantee. Final wallet reward classification, reward totals, pricing, reports, persistence, sync orchestration, CLI, UI, and hosted integration remain deferred. Ten-day initial retrieval, arbitrary later ranges, seven-day reporting, and the planned rolling-72-hour hosted refresh are unchanged. Canonical context version 1.5's prior implementation-status wording is intentionally untouched pending authorized reconciliation.
