import { createHash } from "node:crypto";
import type { RngState } from "./index.js";

const UINT32_RANGE = 0x1_0000_0000;

function word(seed: string, cursor: number): number {
  const seedBytes = Buffer.from(seed, "utf8");
  const header = Buffer.alloc(12);
  header.writeUInt32BE(seedBytes.length, 0);
  header.writeBigUInt64BE(BigInt(cursor), 4);
  const digest = createHash("sha256").update(header).update(seedBytes).digest();
  return digest.readUInt32BE(0);
}

export function seedCommitment(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

export function nextInt(
  input: RngState,
  upperExclusive: number,
): { readonly value: number; readonly rng: RngState } {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0) {
    throw new Error("Random upper bound must be a positive safe integer.");
  }
  if (upperExclusive > UINT32_RANGE) {
    throw new Error("Random upper bound exceeds sha256-counter-v1 range.");
  }
  const limit = Math.floor(UINT32_RANGE / upperExclusive) * upperExclusive;
  let cursor = input.cursor;
  while (true) {
    const candidate = word(input.seed, cursor);
    cursor += 1;
    if (candidate < limit) {
      return {
        value: candidate % upperExclusive,
        rng: { ...input, cursor },
      };
    }
  }
}

export function shuffle<T>(
  values: readonly T[],
  input: RngState,
): { readonly values: readonly T[]; readonly rng: RngState } {
  const shuffled = [...values];
  let rng = input;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const drawn = nextInt(rng, index + 1);
    rng = drawn.rng;
    [shuffled[index], shuffled[drawn.value]] = [
      shuffled[drawn.value]!,
      shuffled[index]!,
    ];
  }
  return { values: shuffled, rng };
}
