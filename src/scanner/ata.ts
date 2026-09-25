import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ASSOCIATED_TOKEN_PROGRAM } from '../normalization/associated-token.js';

export { ASSOCIATED_TOKEN_PROGRAM };
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const marker = new TextEncoder().encode('ProgramDerivedAddress');
const cache = new Map<string, { address: string; bump: number } | null>();

export function base58Decode(value: string): Uint8Array | null {
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const character of value) { if (character !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
export function base58Encode(bytes: Uint8Array): string {
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let text = '';
  while (number > 0n) { text = alphabet[Number(number % 58n)]! + text; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = `1${text}`; }
  return text;
}
/** Decompression as the Solana runtime performs it; lenient (ZIP-215) encodings count as on-curve. */
export function isOnCurve(bytes: Uint8Array): boolean {
  try { ed25519.Point.fromBytes(bytes, true); return true; } catch { return false; }
}
/** Highest-bump off-curve program address, as `find_program_address` derives it. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: Uint8Array): { address: Uint8Array; bump: number } | null {
  if (seeds.length > 15 || seeds.some(seed => seed.length > 32) || programId.length !== 32) return null;
  for (let bump = 255; bump >= 0; bump--) {
    const input = new Uint8Array(seeds.reduce((total, seed) => total + seed.length, 0) + 1 + 32 + marker.length);
    let offset = 0;
    for (const part of [...seeds, Uint8Array.of(bump), programId, marker]) { input.set(part, offset); offset += part.length; }
    const address = sha256(input);
    if (!isOnCurve(address)) return { address, bump };
  }
  return null;
}
/** The owner's associated token account for a mint under an explicit token program; null for invalid keys. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): { address: string; bump: number } | null {
  const key = `${owner}:${mint}:${tokenProgram}`;
  if (cache.has(key)) return cache.get(key)!;
  const seeds = [owner, tokenProgram, mint].map(base58Decode);
  const program = base58Decode(ASSOCIATED_TOKEN_PROGRAM)!;
  const found = seeds.every(seed => seed?.length === 32) ? findProgramAddress(seeds as Uint8Array[], program) : null;
  const result = found ? { address: base58Encode(found.address), bump: found.bump } : null;
  // Bounded memoization: derivation is pure, and a scan touches a limited set of distributor accounts.
  if (cache.size >= 10_000) cache.clear();
  cache.set(key, result);
  return result;
}
