import { z } from 'zod';
import { addressSchema } from '../helius/query.js';
import type { AccountCreationEvidence, InstructionEvidence } from './types.js';

export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const lamports = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d{1,20}$/).refine(value => BigInt(value) <= 18446744073709551615n),
]).transform(value => BigInt(value).toString());
const createInfo = z.object({
  account: addressSchema, mint: addressSchema, wallet: addressSchema,
  source: addressSchema, tokenProgram: addressSchema,
});
const createAccountInfo = z.object({ source: addressSchema, newAccount: addressSchema, owner: addressSchema, lamports });
const accountInfo = z.object({ account: addressSchema });
const mintInfo = z.object({ mint: addressSchema });
const initializeInfo = z.object({ account: addressSchema, mint: addressSchema, owner: addressSchema });

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const typeOf = (instruction: InstructionEvidence) => object(instruction.parsed).type;
const infoOf = (instruction: InstructionEvidence) => object(object(instruction.parsed).info);

/**
 * One associated-token-account creation lifecycle unit: the program's `create`/`createIdempotent`
 * together with the complete CPI list it emits, either empty (the idempotent no-op, which creates
 * nothing) or exactly the four cross-checked instructions below. The parsed `program` label is never
 * authoritative. Any missing, extra, reordered or substituted instruction, any disagreeing field, a
 * token program outside the supported set, or a duplicated inner group leaves the unit unrecognized,
 * and every existing blocker then applies unchanged. No address is derived here.
 */
export function recognizeAccountCreation(
  outer: InstructionEvidence, index: number, inner: readonly InstructionEvidence[] | null,
  tokenPrograms: ReadonlySet<string>,
): AccountCreationEvidence | null {
  if (outer.programId !== ASSOCIATED_TOKEN_PROGRAM || inner === null) return null;
  const kind = z.enum(['create', 'createIdempotent']).safeParse(typeOf(outer));
  const parsed = createInfo.safeParse(infoOf(outer));
  if (!kind.success || !parsed.success || !tokenPrograms.has(parsed.data.tokenProgram)) return null;
  const { account, mint, wallet, source, tokenProgram } = parsed.data;
  const unit = { position: { outer: index, inner: null }, type: kind.data, account, mint, owner: wallet, source, tokenProgram };
  if (inner.length === 0) return { ...unit, created: null };
  if (inner.length !== 4) return null;
  const [size, allocate, immutable, initialize] = inner as [
    InstructionEvidence, InstructionEvidence, InstructionEvidence, InstructionEvidence];
  const sizeInfo = mintInfo.safeParse(infoOf(size));
  const allocateInfo = createAccountInfo.safeParse(infoOf(allocate));
  const immutableInfo = accountInfo.safeParse(infoOf(immutable));
  const initializeParsed = initializeInfo.safeParse(infoOf(initialize));
  if (size.programId !== tokenProgram || typeOf(size) !== 'getAccountDataSize'
    || !sizeInfo.success || sizeInfo.data.mint !== mint) return null;
  if (allocate.programId !== SYSTEM_PROGRAM || typeOf(allocate) !== 'createAccount' || !allocateInfo.success
    || allocateInfo.data.newAccount !== account || allocateInfo.data.owner !== tokenProgram
    || allocateInfo.data.source !== source) return null;
  if (immutable.programId !== tokenProgram || typeOf(immutable) !== 'initializeImmutableOwner'
    || !immutableInfo.success || immutableInfo.data.account !== account) return null;
  if (initialize.programId !== tokenProgram || typeOf(initialize) !== 'initializeAccount3' || !initializeParsed.success
    || initializeParsed.data.account !== account || initializeParsed.data.mint !== mint
    || initializeParsed.data.owner !== wallet) return null;
  return { ...unit, created: { position: { outer: index, inner: 1 }, lamports: allocateInfo.data.lamports,
    dataSize: { outer: index, inner: 0 }, immutableOwner: { outer: index, inner: 2 }, initialization: { outer: index, inner: 3 } } };
}
