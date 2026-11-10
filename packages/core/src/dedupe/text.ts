/** MinHash estimates the Jaccard similarity of two texts' word triples without storing the texts. */

const SHINGLE_WORDS = 3;
/** The estimate is within about 0.05 of the true similarity. */
const SIGNATURE_SIZE = 128;
/** Fewer shingles say too little to tell two texts apart: "Zimmer frei" is in every ad. */
const MIN_SHINGLES = 12;

export type TextSignature = number[];

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

/** 32-bit FNV-1a. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Fixed so a stored signature stays valid. */
const FUNCTIONS: { a: number; b: number }[] = (() => {
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return Array.from({ length: SIGNATURE_SIZE }, () => ({ a: next() | 1, b: next() }));
})();

export function textSignature(text: string): TextSignature | null {
  const list = words(text);
  const shingles = new Set<number>();
  for (let i = 0; i + SHINGLE_WORDS <= list.length; i++) {
    shingles.add(fnv1a(list.slice(i, i + SHINGLE_WORDS).join(" ")));
  }
  if (shingles.size < MIN_SHINGLES) return null;
  const minima = new Array<number>(SIGNATURE_SIZE).fill(Number.MAX_SAFE_INTEGER);
  for (const shingle of shingles) {
    FUNCTIONS.forEach(({ a, b }, index) => {
      const hashed = (Math.imul(a, shingle) + b) >>> 0;
      if (hashed < (minima[index] ?? Number.MAX_SAFE_INTEGER)) minima[index] = hashed;
    });
  }
  return minima;
}

export function textSimilarity(a: TextSignature, b: TextSignature): number {
  let same = 0;
  for (let i = 0; i < SIGNATURE_SIZE; i++) if (a[i] === b[i]) same++;
  return same / SIGNATURE_SIZE;
}
