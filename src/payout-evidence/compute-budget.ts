import type { InstructionEvidence, NormalizedTransaction } from '../normalization/types.js';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode only the small documented compute-budget payload, never arbitrary instructions. */
export function computeBudgetTag(ix: InstructionEvidence): number | null {
  if (ix.programId !== COMPUTE_BUDGET_PROGRAM || ix.parsed !== undefined
    || ix.accounts?.length !== 0 || !ix.data || ix.data.length > 16) return null;
  let value = 0n;
  for (const character of ix.data) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) { bytes.unshift(Number(value & 255n)); value >>= 8n; }
  for (const character of ix.data) { if (character !== '1') break; bytes.unshift(0); }
  const tag = bytes[0];
  if (tag === undefined || ![1, 2, 3, 4].includes(tag)) return null;
  // SetComputeUnitLimit is also emitted with an eight-byte parameter. Accept it only when the upper
  // four bytes are zero, so the value is exactly one the documented four-byte parameter can carry.
  const wideUnitLimit = tag === 2 && bytes.length === 9 && bytes.slice(5).every(byte => byte === 0);
  if (bytes.length !== (tag === 3 ? 9 : 5) && !wideUnitLimit) return null;
  // Heap requests must be a multiple of 1024; other constraints are enforced by successful execution.
  const parameter = bytes.slice(1).reduceRight((n, byte) => n * 256n + BigInt(byte), 0n);
  if (tag === 1 && (parameter < 32768n || parameter > 262144n || parameter % 1024n !== 0n)) return null;
  return tag;
}

export function supportedComputePositions(tx: NormalizedTransaction): Set<number> {
  const positions = new Set<number>();
  const tags = new Set<number>();
  tx.evidence.transaction.message.instructions.forEach((ix, index) => {
    const tag = computeBudgetTag(ix);
    if (tag !== null && !tags.has(tag)
      && !tx.evidence.meta.innerInstructions?.some(group => group.index === index && group.instructions.length > 0)) {
      tags.add(tag); positions.add(index);
    }
  });
  return positions;
}
