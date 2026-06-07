// Optimal Vickrey bidding strategy using a trie + Monte Carlo simulation.
//
// Dominant strategy in a Vickrey (second-price) auction: bid your TRUE value.
// True value = expected marginal score gain from acquiring this letter,
// estimated via Monte Carlo sampling over future bag draws.

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

// Rack balance — bidding adjustments when vowel/consonant ratio is off.
const CONSONANT_PENALTY = 0.3; // suppress consonant bids when rack is vowel-deficient
const VOWEL_BOOST       = 1.5; // boost vowel bids when rack has zero vowels

// Matches Rust's integer arithmetic in length_multiplier() exactly.
// 4-letter: floor(base * 3/2), 6-letter: floor(base * 5/2)
export function computeTotalReward(word: string): number {
  const base = [...word].reduce((s, c) => s + (LETTER_VALUE[c] ?? 0), 0);
  const len = word.length;
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3; // 7+
}

// ---------- Trie ----------

export interface TrieNode {
  children: Map<string, TrieNode>;
  // Max total_reward reachable anywhere in this subtree — used to prune DFS.
  maxSubtreeReward: number;
  // Reward if a valid word ends exactly at this node, otherwise null.
  wordReward: number | null;
}

function makeNode(): TrieNode {
  return { children: new Map(), maxSubtreeReward: 0, wordReward: null };
}

export function buildTrie(dictionary: string[]): TrieNode {
  const root = makeNode();
  for (const word of dictionary) {
    const reward = computeTotalReward(word);
    let node = root;
    for (const ch of word) {
      let child = node.children.get(ch);
      if (!child) {
        child = makeNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    node.wordReward = reward;
  }
  // Propagate maxSubtreeReward bottom-up via post-order DFS.
  function propagate(node: TrieNode): number {
    let max = node.wordReward ?? 0;
    for (const child of node.children.values()) {
      max = Math.max(max, propagate(child));
    }
    node.maxSubtreeReward = max;
    return max;
  }
  propagate(root);
  return root;
}

// Returns the highest total_reward of any word playable from `rack`.
// Mutates rack counts in-place during recursion and restores them — the caller
// must not share the same object across concurrent invocations.
function bestReward(
  node: TrieNode,
  rack: Record<string, number>,
  best: number,
): number {
  if (node.wordReward !== null && node.wordReward > best) {
    best = node.wordReward;
  }
  for (const [letter, child] of node.children) {
    // Skip branch if no tiles available or subtree can't beat current best.
    if ((rack[letter] ?? 0) > 0 && child.maxSubtreeReward > best) {
      rack[letter]!--;
      best = bestReward(child, rack, best);
      rack[letter]!++;
    }
  }
  return best;
}

// Collects all playable {word, reward} pairs — used by chooseWord.
function collectPlayable(
  node: TrieNode,
  rack: Record<string, number>,
  prefix: string,
  out: Array<{ word: string; reward: number }>,
): void {
  if (node.wordReward !== null) {
    out.push({ word: prefix, reward: node.wordReward });
  }
  for (const [letter, child] of node.children) {
    if ((rack[letter] ?? 0) > 0) {
      rack[letter]!--;
      collectPlayable(child, rack, prefix + letter, out);
      rack[letter]!++;
    }
  }
}

// ---------- Bag sampling ----------

// Weighted sampling without replacement from the estimated remaining bag.
function sampleFromBag(
  bagRemaining: Map<string, number>,
  bagTotal: number,
  k: number,
): string[] {
  if (bagTotal <= 0 || k <= 0) return [];

  // Materialise into parallel arrays for cheap mutation.
  const letters: string[] = [];
  const counts: number[] = [];
  for (const [l, c] of bagRemaining) {
    if (c > 0) { letters.push(l); counts.push(c); }
  }

  let total = bagTotal;
  const result: string[] = [];

  for (let i = 0; i < k; i++) {
    if (total <= 0) break;
    let r = Math.random() * total;
    for (let j = 0; j < letters.length; j++) {
      r -= counts[j]!;
      if (r <= 0) {
        result.push(letters[j]!);
        counts[j]!--;
        total--;
        break;
      }
    }
  }
  return result;
}

// ---------- Bid ----------

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  trie: TrieNode;
  bagRemaining: Map<string, number>; // estimated per-letter tile counts left in bag
  bagTotal: number;                  // ground-truth total from match_state.bagTotal
  numParticipants: number;
}

const NUM_SIMS = 150;
const MAX_LOOKAHEAD = 4;    // future letters sampled per simulation
const BUDGET_FRACTION = 0.28;
const BALANCE_FLOOR = 5;

// Vowel floors — all vowels are scaffold for 7-letter words; E and I slightly stronger.
const HIGH_VOWELS          = new Set(['E', 'I']);
const HI_VOWEL_FLOOR_MAX   = 22;
const HI_VOWEL_FLOOR_FRAC  = 0.18;  // at balance 100: 18 → ×boost ~23
const VOWEL_FLOOR_MAX      = 18;
const VOWEL_FLOOR_MIN      = 11;
const VOWEL_FLOOR_FRAC     = 0.16;  // at balance 100: 16 → ×boost ~21

// Consonant tiers (derived from VinceBot analysis — dominant strategy is QZJX+vowels):
//   PREMIUM (very high floor): Q, Z, J, X — anchor 7-letter 3× words (CAZIQUE, JUKEBOX, etc.)
//   HIGH    (full floor):      C, H, Y, K, F, V, W — value density / unlock rate
//   COMMON  (min floor):       N,R,T,S,L,D,G,M,B,P — plentiful connectors; let MC lead
const PREMIUM_CONSONANTS   = new Set(['J', 'Q', 'X', 'Z']);
const HIGH_CONSONANTS      = new Set(['C', 'H', 'Y', 'K', 'F', 'V', 'W']);
const PREMIUM_FLOOR_MAX    = 25;
const PREMIUM_FLOOR_FRAC   = 0.22;  // at balance 100: 22 → ×boost ~28 (budget-cap limited)
const CONSONANT_FLOOR_MAX  = 14;
const CONSONANT_FLOOR_MIN  = 8;
const CONSONANT_FLOOR_FRAC = 0.12;

export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0) return 0;

  const lookahead = Math.min(ctx.bagTotal, MAX_LOOKAHEAD);

  const baseRack: Record<string, number> = {};
  for (const [l, c] of ctx.myRack) baseRack[l] = c;

  let marginalSum = 0;

  for (let i = 0; i < NUM_SIMS; i++) {
    const drawn = sampleFromBag(ctx.bagRemaining, ctx.bagTotal, lookahead);

    // Rack with the auctioned letter + future draws.
    const rackWith: Record<string, number> = { ...baseRack };
    rackWith[ctx.letter] = (rackWith[ctx.letter] ?? 0) + 1;
    for (const l of drawn) rackWith[l] = (rackWith[l] ?? 0) + 1;

    // Rack with only the future draws (without the auctioned letter).
    const rackWithout: Record<string, number> = { ...baseRack };
    for (const l of drawn) rackWithout[l] = (rackWithout[l] ?? 0) + 1;

    marginalSum +=
      bestReward(ctx.trie, rackWith, 0) -
      bestReward(ctx.trie, rackWithout, 0);
  }

  let trueValue = marginalSum / NUM_SIMS;

  // Rack balance: adjust bid based on vowel/consonant ratio.
  // If the rack is consonant-heavy, additional consonants are nearly useless
  // without vowels to pair them with; vowels become urgently needed.
  const vowelCount = [...ctx.myRack.entries()]
    .filter(([l]) => VOWELS.has(l))
    .reduce((s, [, c]) => s + c, 0);
  const rackSize = [...ctx.myRack.values()].reduce((s, c) => s + c, 0);
  const isVowel = VOWELS.has(ctx.letter);
  if (rackSize >= 2) {
    const vowelRatio = vowelCount / rackSize;
    if (!isVowel && vowelRatio < 0.2) {
      trueValue *= CONSONANT_PENALTY; // far too many consonants already
    } else if (isVowel && vowelCount === 0) {
      trueValue *= VOWEL_BOOST;       // no vowels at all — urgently need one
    }
  }

  // Scarcity premium: fewer remaining tiles → fewer future chances → bid more.
  const remaining = ctx.bagRemaining.get(ctx.letter) ?? 0;
  const scarcity = 1 + 1 / (remaining + 1);

  const budgetCap = Math.max(
    0,
    Math.min(ctx.myBalance * BUDGET_FRACTION, ctx.myBalance - BALANCE_FLOOR),
  );

  // Duplicate penalty: already holding 2+ of this letter → halve the floor so
  // the MC's naturally-low marginal value drives the bid instead of the floor
  // forcing us to over-invest in a 3rd+ copy of the same letter.
  const duplicateHeld = ctx.myRack.get(ctx.letter) ?? 0;
  const floorMult = duplicateHeld >= 2 ? 0.5 : 1.0;

  // Consonant floor by tier.
  let consonantFloor: number;
  if (PREMIUM_CONSONANTS.has(ctx.letter)) {
    // Q/Z/J/X: bid aggressively — these anchor 7-letter 3× words (CAZIQUE, JUKEBOX, SQUEEZE…)
    consonantFloor = Math.max(CONSONANT_FLOOR_MIN, Math.min(PREMIUM_FLOOR_MAX, Math.floor(ctx.myBalance * PREMIUM_FLOOR_FRAC)));
  } else if (HIGH_CONSONANTS.has(ctx.letter)) {
    consonantFloor = Math.max(CONSONANT_FLOOR_MIN, Math.min(CONSONANT_FLOOR_MAX, Math.floor(ctx.myBalance * CONSONANT_FLOOR_FRAC)));
  } else {
    consonantFloor = CONSONANT_FLOOR_MIN;  // common consonants: let MC lead
  }

  // Vowel floor: E and I get a stronger floor than A/O/U.
  const vowelFloor = HIGH_VOWELS.has(ctx.letter)
    ? Math.max(VOWEL_FLOOR_MIN, Math.min(HI_VOWEL_FLOOR_MAX, Math.floor(ctx.myBalance * HI_VOWEL_FLOOR_FRAC)))
    : Math.max(VOWEL_FLOOR_MIN, Math.min(VOWEL_FLOOR_MAX, Math.floor(ctx.myBalance * VOWEL_FLOOR_FRAC)));

  const competitiveFloor = floorMult * (isVowel ? vowelFloor : consonantFloor);
  // Early-game boost: bid more aggressively when bag is still full.
  // Fades linearly from 1.3× (bag ≥ 65 tiles) to 1.0× (bag ≤ 10 tiles).
  const earlyBoost = 1 + 0.3 * Math.max(0, Math.min(1, (ctx.bagTotal - 10) / 55));
  const effective = Math.max(trueValue * scarcity, competitiveFloor) * earlyBoost;
  const raw = Math.round(Math.min(effective, budgetCap));
  if (raw < 1 && trueValue > 0 && ctx.myBalance > 0) return 1;
  return Math.max(0, Math.min(raw, ctx.myBalance));
}

// ---------- Word ----------

export interface WordContext {
  myRack: Map<string, number>;
  trie: TrieNode;
  bagRemaining: Map<string, number>;
  bagTotal: number;
  myBalance: number;
}

const N_WORD_SIMS    = 40;  // MC simulations for hold-vs-play
const K_WORD         = 3;   // letters drawn per simulation
const MAX_CANDIDATES = 15;  // top words evaluated with MC (by raw reward)
const LOW_BALANCE    = 20;  // below this coins, lower the hold threshold
// Bag-zone thresholds for hold multiplier
const BAG_EARLY      = 40;  // bag > 40: conservative (don't play weak words)
const BAG_ENDGAME    = 15;  // bag < 15: aggressive (play whatever you have)

export function chooseWord(ctx: WordContext): string | null {
  const rack: Record<string, number> = {};
  for (const [l, c] of ctx.myRack) rack[l] = c;

  const playable: Array<{ word: string; reward: number }> = [];
  collectPlayable(ctx.trie, rack, "", playable);
  if (playable.length === 0) return null;

  // Take top candidates by raw reward — they're the most likely winners.
  playable.sort((a, b) => b.reward - a.reward);
  const candidates = playable.slice(0, MAX_CANDIDATES);

  // Pre-generate shared simulation draws so all evaluations use the same futures.
  const lookahead = Math.min(ctx.bagTotal, K_WORD);
  const simDraws: string[][] = [];
  for (let i = 0; i < N_WORD_SIMS; i++) {
    simDraws.push(sampleFromBag(ctx.bagRemaining, ctx.bagTotal, lookahead));
  }

  // E[hold] = expected best reward from keeping ALL current tiles + future draws.
  // This is the opportunity cost of playing any word.
  let holdSum = 0;
  for (const drawn of simDraws) {
    const futureRack: Record<string, number> = { ...rack };
    for (const l of drawn) futureRack[l] = (futureRack[l] ?? 0) + 1;
    holdSum += bestReward(ctx.trie, futureRack, 0);
  }
  const expectedHold = holdSum / N_WORD_SIMS;

  // For each candidate word W:
  //   E[play(W)] = reward(W) + E[future(leave(W) + draws)]
  // Play W if E[play(W)] > E[hold] — i.e., playing W beats holding everything.
  let bestWord: string | null = null;
  let bestPlayValue = -Infinity;

  for (const { word, reward } of candidates) {
    const leave: Record<string, number> = { ...rack };
    for (const ch of word) leave[ch]!--;

    let leaveSum = 0;
    for (const drawn of simDraws) {
      const futureLeave: Record<string, number> = { ...leave };
      for (const l of drawn) futureLeave[l] = (futureLeave[l] ?? 0) + 1;
      leaveSum += bestReward(ctx.trie, futureLeave, 0);
    }
    const playValue = reward + leaveSum / N_WORD_SIMS;

    if (playValue > bestPlayValue) {
      bestPlayValue = playValue;
      bestWord = word;
    }
  }

  // Bag-aware hold multiplier:
  //   Early game (bag > 40): require play to beat hold by 15% — prevents weak plays like OFAY
  //   Mid game (15–40):      standard — play only if E[play] > E[hold]
  //   End game (bag < 15):   slash threshold 25% — bag nearly empty, take what you can get
  //   Low balance override:  cap at 0.9 so we recoup coins via word score
  let holdMult = ctx.bagTotal > BAG_EARLY   ? 1.15
               : ctx.bagTotal < BAG_ENDGAME ? 0.75
               : 1.0;
  if (ctx.myBalance < LOW_BALANCE) holdMult = Math.min(holdMult, 0.9);

  const holdThreshold = expectedHold * holdMult;
  if (bestPlayValue < holdThreshold) return null;
  return bestWord;
}
