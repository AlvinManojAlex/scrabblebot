// Volume-bidder strategy — modelled on observed bot 13 behaviour.
//
// Key principles:
// 1. Bid a fixed competitive amount on every auction (vowels: 12, consonants: 10,
//    high-value letters: face_value + 3). No MC simulation — fast, predictable.
// 2. Play the highest-scoring available word immediately, no hold check.
//    Cash velocity > waiting for perfect words.

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

// Matches Rust's integer arithmetic in length_multiplier() exactly.
export function computeTotalReward(word: string): number {
  const base = [...word].reduce((s, c) => s + (LETTER_VALUE[c] ?? 0), 0);
  const len = word.length;
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

// ---------- Trie (kept for word selection) ----------

export interface TrieNode {
  children: Map<string, TrieNode>;
  maxSubtreeReward: number;
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

// ---------- Bid ----------

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
}

// Fixed bid tiers — competitive across the full match without MC overhead.
const VOWEL_BID       = 14; // bid this on every vowel
const CONSONANT_BID   = 12; // bid this on common consonants
const HIGHVAL_PREMIUM =  3; // added on top of face value for J/X/Q/Z/K (value ≥ 5)
const BUDGET_FRACTION = 0.30; // spend up to 30% of balance per auction
const BALANCE_FLOOR   =  3;  // keep at least this many coins
// Duplicate penalty: halve bid when already holding ≥1 of a letter,
// except E (27% of words have duplicate E) and S (20%) where multiples stay useful.
const DUPLICATE_EXEMPT  = new Set(['E', 'S']);
const DUPLICATE_PENALTY = 0.5;

export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0) return 0;

  const isVowel = VOWELS.has(ctx.letter);
  const value   = LETTER_VALUE[ctx.letter] ?? 1;

  // Tier 1: high-value rare letters (J=8, X=8, Q=10, Z=10, K=5)
  // Tier 2: vowels — always bid competitively
  // Tier 3: common consonants
  let bid: number;
  if (value >= 5) {
    bid = value + HIGHVAL_PREMIUM; // J→11, K→8, X→11, Q→13, Z→13
  } else if (isVowel) {
    bid = VOWEL_BID;
  } else {
    bid = CONSONANT_BID;
  }

  // Rack balance: if we have far too many consonants and no vowels,
  // suppress more consonant bids and boost vowels.
  const vowelCount = [...ctx.myRack.entries()]
    .filter(([l]) => VOWELS.has(l))
    .reduce((s, [, c]) => s + c, 0);
  const rackSize = [...ctx.myRack.values()].reduce((s, c) => s + c, 0);
  if (rackSize >= 2) {
    const vowelRatio = vowelCount / rackSize;
    if (!isVowel && vowelRatio < 0.2) {
      bid = Math.round(bid * 0.4); // consonant-heavy: back off consonants
    } else if (isVowel && vowelCount === 0) {
      bid = Math.round(bid * 1.4); // no vowels: urgently bid higher
    }
  }

  // Duplicate penalty: already have ≥1 of this letter and it's not in the exempt set.
  const currentCount = ctx.myRack.get(ctx.letter) ?? 0;
  if (currentCount >= 1 && !DUPLICATE_EXEMPT.has(ctx.letter)) {
    bid = Math.round(bid * DUPLICATE_PENALTY);
  }

  const budgetCap = Math.max(0, Math.min(
    ctx.myBalance * BUDGET_FRACTION,
    ctx.myBalance - BALANCE_FLOOR,
  ));

  return Math.max(0, Math.min(Math.round(bid), Math.floor(budgetCap)));
}

// ---------- Word ----------

export interface WordContext {
  myRack: Map<string, number>;
  trie: TrieNode;
  myBalance: number;  // triggers play when low
  bagTotal: number;   // forces play near end of match
  turnsHeld: number;  // consecutive holds without playing — forces play when high
}

// Hold until balance is low, game is ending, or we've been stuck too long.
const LOW_BALANCE_TRIGGER = 25; // play when balance drops below this
const END_GAME_BAG        = 15; // force play when bag has fewer tiles than this
const FORCE_PLAY_AFTER    =  5; // force play after this many consecutive holds

export function chooseWord(ctx: WordContext): string | null {
  // Hold unless one of the three exit conditions fires.
  if (
    ctx.myBalance >= LOW_BALANCE_TRIGGER &&
    ctx.bagTotal > END_GAME_BAG &&
    ctx.turnsHeld < FORCE_PLAY_AFTER
  ) {
    return null;
  }

  const rack: Record<string, number> = {};
  for (const [l, c] of ctx.myRack) rack[l] = c;

  const playable: Array<{ word: string; reward: number }> = [];
  collectPlayable(ctx.trie, rack, "", playable);
  if (playable.length === 0) return null;

  playable.sort((a, b) => b.reward - a.reward);
  return playable[0]?.word ?? null;
}
