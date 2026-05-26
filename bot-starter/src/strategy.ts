// Edit this file to implement your bidding and word-forming strategy.

// Standard Scrabble letter values — useful for valuation.
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export interface BidContext {
  letter: string;        // Letter being auctioned, e.g. "Q"
  myBalance: number;     // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
}

/**
 * Decide how much to bid for `letter`. Return 0 to skip.
 * Default: bid the letter's face value plus a small premium if you don't have one yet.
 */
export function decideBid(ctx: BidContext): number {
  const value = LETTER_VALUE[ctx.letter] ?? 1;
  const have = ctx.myRack.get(ctx.letter) ?? 0;
  // Pay slightly above face value for letters you don't have yet.
  const want = have === 0 ? value + 2 : Math.max(1, value);
  return Math.min(want, Math.max(0, ctx.myBalance));
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Sorted uppercase list, shared at startup
}

/**
 * Try to form a word using letters from `myRack`.
 * Return the word (uppercase) to play, or null to skip.
 *
 * Default strategy: greedily find the longest playable word in the dictionary.
 */
export function chooseWord(ctx: WordContext): string | null {
  // Tally rack.
  const have: Record<string, number> = {};
  for (const [letter, count] of ctx.myRack.entries()) have[letter] = count;

  // Find the longest word we can spell.
  let best: string | null = null;
  for (const word of ctx.dictionary) {
    if (best !== null && word.length <= best.length) continue;
    const need: Record<string, number> = {};
    for (const c of word) need[c] = (need[c] ?? 0) + 1;
    let ok = true;
    for (const [c, n] of Object.entries(need)) {
      if ((have[c] ?? 0) < n) { ok = false; break; }
    }
    if (ok) best = word;
  }
  return best;
}
