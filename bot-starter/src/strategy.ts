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
const MAX_LOOKAHEAD = 4;   // future letters sampled per simulation
const BUDGET_FRACTION = 0.4;
const BALANCE_FLOOR = 5;   // keep at least this many coins in reserve

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

  const trueValue = marginalSum / NUM_SIMS;

  // Scarcity premium: fewer remaining tiles → fewer future chances → bid more.
  const remaining = ctx.bagRemaining.get(ctx.letter) ?? 0;
  const scarcity = 1 + 1 / (remaining + 1);

  const budgetCap = Math.max(
    0,
    Math.min(ctx.myBalance * BUDGET_FRACTION, ctx.myBalance - BALANCE_FLOOR),
  );

  const raw = Math.round(Math.min(trueValue * scarcity, budgetCap));
  if (raw < 1 && trueValue > 0 && ctx.myBalance > 0) return 1;
  return Math.max(0, Math.min(raw, ctx.myBalance));
}

// ---------- Word ----------

export interface WordContext {
  myRack: Map<string, number>;
  trie: TrieNode;
}

const TOP_K_WORDS = 20;
const LEAVE_DISCOUNT = 0.5; // discount on leave value — future plays are uncertain

export function chooseWord(ctx: WordContext): string | null {
  const rack: Record<string, number> = {};
  for (const [l, c] of ctx.myRack) rack[l] = c;

  const playable: Array<{ word: string; reward: number }> = [];
  collectPlayable(ctx.trie, rack, "", playable);
  if (playable.length === 0) return null;

  // Sort by raw reward, then evaluate top-K candidates with leave value.
  playable.sort((a, b) => b.reward - a.reward);
  const candidates = playable.slice(0, TOP_K_WORDS);

  let bestWord: string | null = null;
  let bestAdjusted = -1;

  for (const { word, reward } of candidates) {
    // Build leave rack (letters remaining after playing this word).
    const leave: Record<string, number> = { ...rack };
    for (const ch of word) leave[ch]!--;

    const leaveVal = bestReward(ctx.trie, leave, 0);
    const adjusted = reward + LEAVE_DISCOUNT * leaveVal;

    if (adjusted > bestAdjusted) {
      bestAdjusted = adjusted;
      bestWord = word;
    }
  }

  return bestWord;
}
