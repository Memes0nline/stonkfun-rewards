import { z } from 'zod';
import { addressSchema } from '../helius/query.js';
import { SYSTEM_PROGRAM } from '../normalization/associated-token.js';
import type { InstructionEvidence, InstructionPosition, NormalizedTransaction } from '../normalization/types.js';

export { SYSTEM_PROGRAM };
const lamports = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d{1,20}$/).refine(value => BigInt(value) <= 18446744073709551615n),
]).transform(value => BigInt(value).toString());
const transferInfo = z.object({ source: addressSchema, destination: addressSchema, lamports });

export const nativeBalances = z.object({
  fee: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  preBalances: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  postBalances: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
});

export interface NativeTransferEvidence {
  position: InstructionPosition;
  source: string;
  destination: string;
  lamports: string;
}

/** One account key's observed lamport movement, or null when the arrays are not complete evidence. */
export function lamportDelta(tx: NormalizedTransaction, address: string): bigint | null {
  const keys = tx.evidence.transaction.message.accountKeys;
  const parsed = nativeBalances.safeParse(tx.evidence.meta);
  const index = keys.findIndex(item => item.pubkey === address);
  if (!parsed.success || index < 0 || parsed.data.preBalances.length !== keys.length
    || parsed.data.postBalances.length !== keys.length) return null;
  return BigInt(parsed.data.postBalances[index]!) - BigInt(parsed.data.preBalances[index]!);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function decode(instruction: InstructionEvidence, position: InstructionPosition): NativeTransferEvidence | null {
  const parsed = object(instruction.parsed);
  if (parsed.type !== 'transfer') return null;
  const info = transferInfo.safeParse(object(parsed.info));
  return info.success ? { position, ...info.data } : null;
}

/**
 * Every System-program instruction in the transaction, decoded as a plain lamport transfer. Returns
 * null when any of them is a different or malformed System operation — `createAccount`,
 * `transferWithSeed`, `allocate`, `assign`, a nonce operation — because the batch is then not a
 * plain lamport payout and nothing here may be assumed about its lamport movement.
 */
export function nativeTransfers(tx: NormalizedTransaction): NativeTransferEvidence[] | null {
  if (tx.evidence.meta.innerInstructions === null) return null;
  const transfers: NativeTransferEvidence[] = [];
  const positioned = [
    ...tx.evidence.transaction.message.instructions.map((instruction, outer) => ({ instruction, position: { outer, inner: null } })),
    ...tx.evidence.meta.innerInstructions.flatMap(group => group.instructions
      .map((instruction, inner) => ({ instruction, position: { outer: group.index, inner } }))),
  ];
  for (const item of positioned) {
    if (item.instruction.programId !== SYSTEM_PROGRAM) continue;
    const decoded = decode(item.instruction, item.position);
    if (!decoded) return null;
    transfers.push(decoded);
  }
  return transfers;
}
