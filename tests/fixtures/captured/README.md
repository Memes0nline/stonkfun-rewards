# Captured public payout evidence

`payout-4Am7wVR.json` was extracted offline on 2026-09-21 from a consistent SQLite backup of the retained live-verification evidence. It is **captured provider evidence**, distinct from the synthetic fixtures in the parent directory. No new provider or explorer request was made.

The file contains one complete retained Helius transaction, its original hydration provenance and stored observation hash, and the exact original StonkFun distribution row with its feed provenance and referenced successful `/rewards?limit=100` source. Only unrelated launch/pair source records were omitted. No transaction field, amount, address, ordering field or row extension was edited. The full transaction is necessary to reconcile all 17 transfers, ownership, balances, fees and other instructions. There is no database, credential, authenticated URL, quote catalogue or price snapshot in this fixture.

SHA-256 over `JSON.stringify` of the parsed retained values (property order preserved):

- Transaction: `034b3efc838dad32b89d7d01481ee4098e22b1d5c615864ea4ec9015d636fe03`
- Selected feed: `33fbbea978b8219f5b53980d962df4314201c2a78e74123ea550ade03a50ca6e`

Run `node node_modules/vitest/vitest.mjs run tests/captured-payout.test.ts` from the repository root. The test uses production normalization, SQLite ingestion, classification and reporting, verifies exact amounts and unpriced status, and checks repeat ingestion after reopening. Global test setup rejects live fetches. Quote membership is derived from the retained official row; no feed row or price is manufactured.

Recipient `Ap8XtRRi9Ywmw4YcGN8i46eVv4PkFxCvBAbpeVbYh1s8` receives exactly **1,629,660 raw units** of `PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua`. The gross instruction is 1,646,122; the feed's 25,424,126 is a transaction aggregate, not that recipient's receipt. The recipient is unrelated to any wallet this project scanned. A single replay establishes neither historical coverage nor permanent authority trust. Provider attribution was retained; independent explorer confirmation remains unperformed.
