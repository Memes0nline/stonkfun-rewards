# Transaction normalization and individual-credit identity

Normalization is at **version 2**; individual-credit identity remains **v1** and is unchanged. Version 2 adds exactly one recognized instruction shape, the associated-token-account creation lifecycle unit described below, and changes nothing else. No transfer moved position, was added or was removed, so every retained credit identity stays valid.

The standalone scanner now consumes this unchanged pure contract through wallet-neutral persisted chain evidence and a separate wallet classifier. See [SCANNER.md](SCANNER.md) for durable deduplication/conflict quarantine and payout policy v2. The component's own APIs and historical verification below remain unchanged; references to deferred storage/classification describe the original component checkpoint.

This module is a pure, framework-independent evidence transform. It does not fetch, read the clock or environment, persist, verify payout authorities, classify rewards, or calculate totals. It accepts the existing `FullTransaction` jsonParsed shape, a searched wallet, a canonical network (`mainnet-beta`, `devnet`, or `testnet`), and explicit provenance. All supported transfers are retained, including outgoing and unrelated transfers, to explain account movements.

## Public contract

`normalizeTransaction(input)` is exported from `src/index.ts`, alongside `individualCreditIdentity` and `groupCreditIdentities`. Inputs are revalidated with the existing full-transaction schema and a small context schema. Invalid structural inputs throw a generic `Invalid normalization input` error. Semantically unsupported or contradictory evidence produces reason codes and retained evidence.

Provenance contains `source` (`helius`, `solana-rpc`, or `fixture`), a caller-owned opaque `evidenceId`, explicit ISO `retrievedAt`, and `commitment` (`confirmed`, `finalized`, or `unknown`). Network is supplied separately and never guessed. The engine does not authenticate provider evidence, verify cryptographic signatures, establish finality, or discover which cluster produced it. The caller must supply correctly attributed, validated, credential-free transaction evidence. The Helius client already rejects credential reflections; this module has no key or URL input and is not a sanitizer for arbitrary secrets hidden in transaction extensions. It preserves those JSON extensions and logs exactly.

The result includes the full validated transaction snapshot, provenance, signers, failed/wallet-signer flags, per-account evidence, supported transfers, and located issues. `classification` is always `not_performed`. No inferred transfer is created from a balance delta alone.

## Instructions and account references

Supported parsed token instructions are `transfer`, `transferChecked`, and Token-2022 `transferCheckedWithFee`. Recognition uses the actual program ID:

- Classic SPL Token: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Token-2022: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`

The parsed `program` label is not authoritative. Token-2022 can be labeled `spl-token`. Checked transfers require mint and raw token amount/decimals; explicit fees use Agave's `feeAmount.{amount,decimals}` shape. Single authority and multisig authority/signers are separate from transaction signers. CPI authorities/signers are not assumed to be transaction signers or trusted distributors.

Outer positions use the original zero-based message-instruction index. Inner positions use their containing outer index plus their original zero-based ordinal in that group's complete CPI list, including unsupported instructions. `stackHeight` remains evidence, never an identity index. Groups are ordered by outer position for deterministic output. Duplicate inner groups or nonexistent outer references block credit proofs while preserving observations.

Solana jsonParsed `message.accountKeys` already contains resolved lookup-table accounts. Token balance `accountIndex` indexes that array directly; parsed/partially decoded instructions use addresses. The normalizer never appends `meta.loadedAddresses` or interprets address-table lookup indexes as transaction account indexes. Supplemental lookup metadata is retained but never used to repair incomplete parsed keys. Out-of-range balance references, missing instruction/program-account references, duplicate keys, and inconsistent signer counts/lookup signers block proofs. Compiled/binary instruction decoding is outside v1.

## Ownership, mint, decimals, and lifecycle

Account evidence retains every pre/post balance row, original raw amount string, optional owner/program fields, and their array locations. Owner resolution is consensus among observed pre/post token-balance owners and parsed token-account initialization owners. Transfer authorities, destination addresses, closure authorities, lamport recipients, and the searched wallet are never substituted for owner evidence. One available owner observation can resolve consensus when the opposite balance omits owner; the omission remains visible in the original balance row. No observations means `missing`; disagreement means `conflicting` with a null resolved value.

Mint evidence comes from balances, checked transfers, and account initialization. Decimals and token-program observations are also reconciled across other accounts with the same unambiguous mint. Missing/conflicting mint or decimals remain explicit. No registry or token metadata is used to fill missing accounting evidence.

`initializeAccount`, `initializeAccount2`, `initializeAccount3`, and `closeAccount` are retained as lifecycle evidence. Initialization can establish observed owner/mint consensus, but v1 never synthesizes a zero starting balance. Closure never proves a zero ending balance or ownership. Even when both balances exist, lifecycle activity blocks proofs involving that account: v1 does not split close/recreate epochs or reconstruct intra-transaction ownership timelines. Direction/self flags remain unknown across lifecycle or unsupported token operations. Original observations stay visible. The only exception to this paragraph is the recognized creation unit below, which proves the account's zero starting balance from its own `system createAccount` and gives it exactly one lifetime.

## The recognized associated-token-account creation unit (v2)

`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`'s `create` and `createIdempotent` are recognized as **one lifecycle unit** together with the complete CPI list they emit, and nothing else is added to the supported vocabulary. Recognition requires all of:

1. The actual program ID is the associated-token-account program; the parsed `program` label is not authoritative.
2. Parsed `type` is `create` or `createIdempotent`, and `parsed.info` supplies `account`, `mint`, `wallet`, `source` and `tokenProgram` as valid addresses, with `tokenProgram` one of the two supported token programs.
3. The outer index has at most one inner-instruction group, and that group's complete CPI list is either empty, or exactly these four in this order: the named token program's `getAccountDataSize` with `info.mint` equal to `mint`; `11111111111111111111111111111111`'s `createAccount` with `info.newAccount` equal to `account`, `info.owner` equal to `tokenProgram`, `info.source` equal to `source` and a valid unsigned `info.lamports`; the token program's `initializeImmutableOwner` on `account`; and its `initializeAccount3` with `info.account`, `info.mint` and `info.owner` equal to `account`, `mint` and `wallet`.

An empty CPI list is the idempotent no-op: the account already existed and nothing was created. No address is derived here; the normalizer takes no registry, metadata or curve dependency, and proof comes from the parsed `createAccount` and `initializeAccount3` fields alone. Any missing, extra, reordered or substituted instruction, any disagreeing field, an unsupported token program, or a duplicated inner group leaves the unit unrecognized, and every existing blocker applies unchanged. Recognized units are retained as `accountCreations` on the result, with their cross-checked instruction positions and the exact `createAccount` lamports.

Three consequences follow, each confined to a recognized unit:

- **Supported lifecycle, not unsupported evidence.** `getAccountDataSize` and `initializeImmutableOwner`, only at their exact positions inside a recognized unit, no longer produce `unsupported_token_instruction`. Both are pure account-shape operations that cannot move tokens. They contribute no balance change and no owner, mint or token-program observation. They are accepted at no other position, under no other token program, and for no other instruction type: the blanket rule in "Unsupported and unresolved evidence" stays in force for `mintTo`, `burn`, `syncNative`, `setAuthority`, `freezeAccount`, `thawAccount`, withheld-fee operations and every extension operation. A transaction holding a recognized unit **and** any other unsupported token instruction is still blocked transaction-wide.
- **A proven zero starting balance.** When a recognized unit's own `system createAccount` allocated the address in this transaction, the account did not exist before it and therefore held no tokens before it. Such an account records `createdInTransaction` and reconciles from a starting balance of zero. This is the single narrow exception to "v1 never synthesizes a zero starting balance", and it is licensed by positive creation evidence, never by a missing row. An account that has a pre-balance row **and** a recognized creation, or two recognized creations, is contradictory evidence and stays blocked with `conflicting_balance`. A `createAccountWithSeed`, an `allocate`/`assign` pair, any other creation path and the no-op form all synthesize nothing.
- **One lifetime, so no epoch to split.** The unit's `initializeAccount3` still records lifecycle evidence and still establishes owner and mint consensus. When an account's entire lifecycle list is that single entry and the account was provably created here, it no longer receives `account_lifecycle`, and its direction and self flags may resolve. Any second lifecycle entry — a `closeAccount`, a second initialization, an initialization outside a unit — restores the block, and a `closeAccount` on a transfer's source still withholds proof.

## Exact amounts and reconciliation

`grossAmountRaw` and `explicitFeeRaw` preserve instruction strings, including leading zeros. Raw token amounts must be unsigned integer strings within u64 for supported accounting; larger strings remain retained in unresolved source evidence. Arithmetic uses `bigint` internally and returns JSON-safe decimal strings. `uiAmount` and `uiAmountString` are never accounting inputs. Decimals are retained as integer metadata; no token display or USD arithmetic occurs.

Each account has a single `balanceChangeRaw = observed post - observed pre` only when both snapshots and mint/decimal/program evidence are unambiguous. Missing balance entries are not zero. Duplicate rows are not selected or summed. Failed-transaction deltas remain observed evidence, with all credit proofs disabled.

For each account, the normalizer solves:

```text
balance change = sum(incoming net credits) - sum(outgoing gross debits)
```

Same-account transfers contribute no movement and receive no net-credit proof. A classic transfer's proposed net equals gross. Token-2022 with an explicit verified fee proposes `gross - fee`. An ordinary Token-2022 transfer has an unknown net bounded from zero to gross; fee configuration and percentage are never guessed.

After subtracting known incoming credits and adding outgoing debits, one remaining unknown net can be solved uniquely. Multiple unknown nets remain `ambiguous_fee_allocation` unless the residual forces all nets to zero or all to their respective gross maxima. Explicit and unknown fee transfers can coexist in the equation. A residual outside feasible bounds is `unexplained_balance_change`.

A transfer exposes `netCreditRaw` only when both source and destination accounts reconcile and all its required ownership, asset, lifecycle, instruction, and transaction evidence is supported. Missing source owners or source balance snapshots also withhold proof in this conservative version. A known instruction amount is never sufficient by itself, and neither an entire account delta nor an aggregate residual is assigned to each incoming instruction. `netCreditBasis` records whether a supported instruction plus balances or unique reconciliation established the amount.

`netCreditRaw` is the destination's per-instruction token credit after fees. It is not the wallet's transaction-wide net increase, retained end-of-transaction balance, or a StonkFun reward. A wallet may receive 100 and send 40 in one transaction: the incoming instruction credit is 100, the outgoing destination credit is 40, and the wallet account change is 60. Self-transfers between different owned accounts retain their exact destination credits and self flags. Consumers must retain these distinctions for later classification; never sum account deltas and instruction credits together.

## Unsupported and unresolved evidence

Unknown/partially decoded token instructions, including mints, burns, `syncNative`, authority changes, withheld-fee withdrawals/harvests, and extension operations, produce `unsupported_token_instruction` and conservatively block all per-transfer credit proofs in the transaction. V1 deliberately does not guess their effects or selectively assume they are harmless. Invalid supported transfer fields similarly block proofs and remain in full source evidence. A mismatched token label/program produces `unsupported_program`.

Other programs are retained as located `uninterpreted_instruction` evidence. They may wrap supported token CPIs; their presence alone does not block a matching token equation when inner recording is available. This is not evidence that their economic activity is a reward or otherwise safe to classify. Missing (`null`) inner recording blocks all credit proofs. Unexplained changes on accounts without supported transfer instructions remain account-level issues, never synthetic credits. Issues are diagnostic evidence, not classification reason codes or an overall transaction success verdict.

## Stable identity and conflicting observations

The exact v1 serialization is a JSON tuple string:

```text
["solana-token-credit",1,network,primarySignature,outerIndex,innerIndexOrNull,recipientOrdinal]
```

V1's supported instructions each have one destination, so `recipientOrdinal` is always `0`. The helper reserves nonnegative recipient ordinals for explicit recipient slots; future multi-recipient support must define those slots without sorting by mutable metadata and review version compatibility. An outer instruction and its first CPI have different identities (`null` versus `0`). Identical-looking transfers at distinct instruction positions remain distinct.

Wallet, recipient address, source, mint, amount, metadata, retrieval time, finality, and classifier status are deliberately excluded from identity. A contradictory destination occupies the same immutable recipient slot and must surface as conflicting evidence, not silently create a second credit. Unresolved transfers already carry the same identity that later enriched observations will use. Network aliases are not accepted; callers must use a consistent canonical cluster label.

`groupCreditIdentities(results)` provides pure review grouping. It first associates every input result by network and primary signature, including results with zero transfers. Each identity's `observations` retains every present transfer and its result/transfer indexes. `missingTransferObservations` retains `{ resultIndex }` for every associated transaction observation lacking that identity. Both arrays refer to the supplied results, preserving access to full evidence, wallet context, and provenance. A missing transfer never becomes a synthetic transfer or zero-value credit; a transaction with no supported transfer in any observation creates no credit group. Different networks and primary signatures remain isolated.

Exact repeats (object-key-order independent, excluding retrieval provenance) are `repeated`. Any transaction evidence, transfer, or searched-wallet-context difference is conservatively `conflicting`, with `conflicting_identity_evidence`; even harmless metadata enrichment requires explicit later reconciliation. An associated observation missing a transfer always conflicts that existing identity, whether the transfer was replaced by an unsupported operation, inner recording disappeared, or just one credit position is absent. With multiple credits, changed transaction evidence also conflicts the retained identities under the same broad comparison policy, but only absent identities receive missing-transfer references. Duplicate positions within one result are also conflicting, including identical duplicates. Conflict status is independent of input order, and later exact repeats cannot clear it. Reference indexes and observation order follow the supplied results. No observation is overwritten, summed, persisted, or selected as a winner. Future durable storage must quarantine unresolved identity groups and may not use last-write-wins upserts or independently count their alternatives.

## Verification and scope

Deterministic synthetic fixtures model realistic RPC structures rather than claiming captured live compatibility. They cover outer/inner transfers, repeat observations, duplicate positions, shared signatures, multiple accounts, lookup references, large amounts, decimal extremes, ownership and lifecycle uncertainty, incoming/outgoing/self activity, fees, unsupported operations, failures, and identity conflicts. Missing-transfer regressions use the real normalizer and grouping helper for unsupported replacements, empty/missing inner groups, null inner recording, and one missing outer/inner credit among multiple credits, in both orders and after exact repeats. They also check evidence/provenance references, wallet-context policy, unchanged repeats, network/signature isolation, input preservation, and absence without synthetic identities. Existing history tests continue to enforce the ten-day initial fetch, arbitrary later sync ranges, and separate seven-day reporting requirement.

Browser review accepted the implementation after correcting missing-transfer conflict detection. The checkpoint retains `missingTransferObservations`, unchanged identity v1, and conflicts across both input orders and later repeats. The tests listed above verify it.

No new dependency, live data API request, environment-file read, persistence, pricing, classifier, CLI or UI is part of the normalization checkpoint. The separately authorized [payout-evidence module](PAYOUT_EVIDENCE.md) now consumes these full observations and the unchanged identity/conflict grouping. It records reconciled evidence and observed authority roles; final wallet classification remains deferred.

Documentation/source references consulted on 2026-09-21 UTC: [Solana JSON structures](https://solana.com/docs/rpc/json-structures), [Solana transfer fees](https://solana.com/docs/tokens/extensions/transfer-fees), [Agave parsed token instructions](https://github.com/anza-xyz/agave/blob/master/transaction-status/src/parse_token.rs), and [Agave parsed transfer-fee instructions](https://github.com/anza-xyz/agave/blob/master/transaction-status/src/parse_token/extension/transfer_fee.rs). These establish RPC/parser conventions, not fresh provider evidence or reward-classification coverage.
