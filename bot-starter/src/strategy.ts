// Edit this file to implement your bidding and word-forming strategy.

// Standard Scrabble letter values — useful for valuation.
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  dictionary: string[];
  auctionType: "FirstPrice" | "Vickrey";
  participantCount: number;
  auctionIndex: number; // how many auctions have completed in this match so far
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  minScore: number; // only submit words scoring at least this
}

// Score a word: sum of letter values times length multiplier.
function wordScore(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 1;
  const len = word.length;
  const mult = len >= 7 ? 3.0 : len === 6 ? 2.5 : len === 5 ? 2.0 : len === 4 ? 1.5 : 1.0;
  return base * mult;
}

// Auction index boundaries for the 4 bid phases.
// Matches typically have ~65-70 auctions; prices start at 15-25 and fall to
// 3-8 by the end as other bots deplete their budgets.
const PHASE2_START = 6;   // switch from very-low to moderate
const PHASE3_START = 16;  // switch from moderate to higher
const PHASE4_START = 26;  // switch to late-game paced bidding
// Stop bidding when rack reaches this many total letters — wait to play a word.
export const MAX_RACK_LETTERS = 7;
// Minimum word score before we bother submitting — filters out short junk words.
export const MIN_WORD_SCORE = 20;

/**
 * Decide how much to bid for `letter`. Return 0 to skip.
 *
 * Four-phase ramp designed around typical match price curves:
 *   Phase 1 (0-5):   very small — intentionally lose while competition is ~20+
 *   Phase 2 (6-15):  moderate   — start winning as prices ease to ~12-17
 *   Phase 3 (16-25): higher     — win more as budgets thin to ~8-14
 *   Phase 4 (26+):   30% of balance — beat broke bots paying 3-8, paying
 *                    second price means actual cost is low even at a high bid
 */
export function decideBid(ctx: BidContext): number {
  // Don't bid if rack is already full — wait until a word is played.
  const rackSize = Array.from(ctx.myRack.values()).reduce((a, n) => a + n, 0);
  if (rackSize >= MAX_RACK_LETTERS) return 0;

  const faceValue = LETTER_VALUE[ctx.letter] ?? 1;
  const isCommon = faceValue === 1; // A E I O U L N S T R
  const i = ctx.auctionIndex;

  let bid: number;

  if (i < PHASE2_START) {
    // Phase 1: very low — let others overpay early, preserve full budget.
    bid = isCommon ? 8 : faceValue + 2;
  } else if (i < PHASE3_START) {
    // Phase 2: moderate — enter competition as prices start to ease.
    bid = isCommon ? 14 : faceValue + 5;
  } else if (i < PHASE4_START) {
    // Phase 3: higher — prices are falling, win more letters.
    bid = isCommon ? 20 : faceValue + 8;
  } else if (ctx.auctionType === "Vickrey") {
    // Phase 4 Vickrey: bid 30% of balance — other bots are nearly broke so
    // second price (what we actually pay) is just 3-8, spending little.
    bid = Math.floor(ctx.myBalance * 0.3);
  } else {
    // Phase 4 FirstPrice: shade the phase-3 bid down by (N-1)/N.
    const base = isCommon ? 20 : faceValue + 8;
    const n = Math.max(2, ctx.participantCount);
    bid = Math.max(1, Math.round(base * (n - 1) / n));
  }

  return Math.min(bid, ctx.myBalance);
}

/**
 * Choose the highest-scoring playable word above minScore.
 * Returns null if nothing clears the threshold — bot will keep collecting.
 */
export function chooseWord(ctx: WordContext): string | null {
  const have: Record<string, number> = {};
  for (const [letter, count] of ctx.myRack.entries()) have[letter] = count;

  let best: string | null = null;
  let bestScore = ctx.minScore - 1;

  for (const word of ctx.dictionary) {
    const score = wordScore(word);
    if (score <= bestScore) continue;
    const need: Record<string, number> = {};
    for (const c of word) need[c] = (need[c] ?? 0) + 1;
    let ok = true;
    for (const [c, n] of Object.entries(need)) {
      if ((have[c] ?? 0) < n) { ok = false; break; }
    }
    if (ok) {
      best = word;
      bestScore = score;
    }
  }

  return best;
}
