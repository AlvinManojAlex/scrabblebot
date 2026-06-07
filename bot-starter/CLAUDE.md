# Bot Starter — Codebase Guide & Strategy Plan

## Project Overview

Scrabble-variant auction game running on SpacetimeDB. Three layers:
- **Rust backend** (`../spacetimedb/src/`) — tables, reducers, game logic
- **Bot starter** (`src/`) — TypeScript bot that bids on letters and plays words
- **React SPA** (`../src/`) — spectator/admin frontend

Bots connect to SpacetimeDB via the generated bindings (`src/module_bindings/`). The only files to edit are `src/strategy.ts` and `src/index.ts`. Never touch `module_bindings/`.

---

## Game Mechanics (from server source)

### Auction
- One letter is auctioned per round; auction window = **1 second** (`AUCTION_DURATION_MS = 1000`)
- **Vickrey (second-price)**: winner pays the second-highest bid, or the reserve (1 coin) if only one bidder
- Dominant strategy: **bid your true value** — bidding truthfully is weakly dominant
- Starting balance: **100 coins** per bot per match
- If no one bids, the letter is **returned to the bag** (`return_to_bag`) and auctioned again in a future round

### Scoring
Playing a word earns: `total_reward = base_score × length_multiplier`

| Word length | Multiplier |
|---|---|
| ≤ 3 | 1× |
| 4 | 1.5× (floor) |
| 5 | 2× |
| 6 | 2.5× (floor) |
| 7+ | 3× |

`base_score` = sum of Scrabble letter values for each character in the word.

**Must use integer division** matching Rust's `base * num / denom`:
- 4-letter word, base=5 → `floor(5 * 3 / 2)` = 7, not 7.5

### Letter Bag
Standard Scrabble distribution, **98 tiles, no blanks**:

```
A=9  B=2  C=2  D=4  E=12 F=2  G=3  H=2  I=9  J=1
K=1  L=4  M=2  N=6  O=8  P=2  Q=1  R=6  S=4  T=6
U=4  V=2  W=2  X=1  Y=2  Z=1
```

Letter point values (from `../spacetimedb/src/letters.rs`):
```
1pt: A E I O U L N S T R
2pt: D G
3pt: B C M P
4pt: F H V W Y
5pt: K
8pt: J X
10pt: Q Z
```

### Starting Racks
Each bot receives **5 tiles drawn randomly from the bag** before the first auction. These are private — you cannot see opponents' starting tiles.

### Visibility
| Table | Visible to bots? |
|---|---|
| `auction` | ✅ public |
| `auction_result` | ✅ public — includes `winnerBotId` and `letter` |
| `match_state` | ✅ public — includes `bagTotal` (remaining tiles) |
| `match_participant` | ✅ public — includes all bots' `balance` and `score` |
| `word_play` | ✅ public — includes all words played and by whom |
| `bot` | ✅ public |
| `my_rack` (view) | ✅ own letters only |
| `holding` (raw table) | ❌ private — opponents' racks hidden |
| `pending_bid` | ❌ private — can't see competing bids |
| `bag_letter` (raw) | ❌ private — per-letter bag counts hidden |

**Opponent rack inference**: You can reconstruct a lower bound on any opponent's rack from public data:
`opponent_rack[L] ≥ (letters L won at auction) − (letters L used in word_play)`

---

## File Structure

```
src/
  index.ts       — SpacetimeDB connection, event listeners, context gathering
  strategy.ts    — decideBid(), chooseWord() — the only file contestants edit freely
  module_bindings/ — generated, DO NOT EDIT
```

Key globals in `index.ts`:
- `DICTIONARY` — loaded from `../spacetimedb/wordlist.txt`, uppercase, length ≥ 2
- `myBotId: bigint | null` — resolved after subscription is applied
- `bidsByAuction: Set<string>` — deduplication key `"matchId:auctionId"` prevents double-bidding
- `lastWordAttemptByMatch: Map<string, number>` — 500ms cooldown between word submission attempts

Key helpers in `index.ts`:
- `rackForMatch(conn, matchId)` → `Map<string, number>` — own letters for a specific match
- `participantForMatch(conn, matchId)` → `{balance, score}` — own balance/score

---

## Strategy Plan: Optimal Vickrey Bidding (MC + Trie)

### Why this approach
1. Vickrey = bid true value. Problem reduces to accurately computing "how much is this letter worth to me?"
2. Linear dictionary scan (~2-5ms) makes naive Monte Carlo too slow in the 1-second window. A **trie** drops each query to ~0.3ms → 150 simulations fit in ~120ms, well within budget.

---

### Step 1: Trie (strategy.ts)

Build once at startup. Each node stores children and `maxSubtreeReward` for pruning.

```typescript
interface TrieNode {
  children: Map<string, TrieNode>;
  maxSubtreeReward: number; // max reward reachable below this node — enables DFS pruning
  wordReward: number | null; // reward if a word ends here
}

export function buildTrie(dictionary: string[]): TrieNode
```

**Insert:** walk/create nodes per character. At the leaf, set `wordReward = computeTotalReward(word)`. On the way back up, propagate `maxSubtreeReward = max(child.maxSubtreeReward, wordReward)`.

**`bestReward(node, rack, currentBest)`** — rack-constrained DFS:
```
if node.wordReward > currentBest: update currentBest
for [letter, child] in node.children:
  if rack[letter] > 0 AND child.maxSubtreeReward > currentBest:  // prune!
    rack[letter] -= 1
    currentBest = bestReward(child, rack, currentBest)
    rack[letter] += 1
return currentBest
```

**`collectPlayable(node, rack)`** — same DFS but collects all `{word, reward}` pairs; used by `chooseWord`.

**`computeTotalReward(word: string): number`** — must match Rust integer division exactly:
```typescript
export function computeTotalReward(word: string): number {
  const base = [...word].reduce((s, c) => s + (LETTER_VALUE[c] ?? 0), 0);
  const len = word.length;
  if (len <= 3) return base;
  if (len === 4) return Math.floor(base * 3 / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor(base * 5 / 2);
  return base * 3;
}
```
Export this — `index.ts` needs it.

---

### Step 2: Extended BidContext (strategy.ts)

```typescript
export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  // New:
  trie: TrieNode;
  bagRemaining: Map<string, number>; // estimated per-letter tile counts left in bag
  bagTotal: number;                  // ground-truth from match_state.bagTotal
  numParticipants: number;
}
```

---

### Step 3: decideBid() — Monte Carlo true value (strategy.ts)

```
NUM_SIMS = 150
LOOKAHEAD = min(bagTotal, 4)   // future letters to sample per simulation

marginals = []
for i in 0..NUM_SIMS:
  drawn = sampleFromBag(bagRemaining, bagTotal, LOOKAHEAD)  // weighted without-replacement draw

  rack_with    = myRack + {letter: +1} + drawn letters
  rack_without = myRack + drawn letters

  marginals.push(
    bestReward(trie, rack_with, 0) - bestReward(trie, rack_without, 0)
  )

true_value = mean(marginals)

// Scarcity: letter is rarer → fewer future opportunities → bid more
remaining = bagRemaining.get(letter) ?? 0
scarcity  = 1 + 1 / (remaining + 1)   // 0 left → 2.0×, 9 left → 1.1×

// Budget: never spend more than 40% of balance in one auction; keep 5-coin floor
budget_cap = min(myBalance * 0.4, myBalance - 5)

bid = round(min(true_value * scarcity, budget_cap))
if bid < 1 and true_value > 0 and myBalance > 0: bid = 1
return max(0, bid)
```

**`sampleFromBag(bagRemaining, bagTotal, k)`** — weighted sampling without replacement:
```
tempBag = copy of bagRemaining entries
tempTotal = bagTotal
result = []
for i in 0..k:
  if tempTotal <= 0: break
  r = Math.random() * tempTotal
  for [letter, count] in tempBag:
    r -= count
    if r <= 0:
      result.push(letter)
      tempBag[letter] -= 1; tempTotal -= 1
      break
return result
```

---

### Step 4: chooseWord() — Score-maximising with leave value (strategy.ts)

```typescript
export interface WordContext {
  myRack: Map<string, number>;
  trie: TrieNode;
}
```

```
playable = collectPlayable(trie, myRack)   // [{word, reward}]
if empty: return null

sort playable by reward descending
top20 = playable.slice(0, 20)

best_word = null; best_adjusted = -1
for {word, reward} of top20:
  remaining_rack = myRack minus letters_in(word)
  leave_val      = bestReward(trie, remaining_rack, 0)
  adjusted       = reward + 0.5 * leave_val    // 0.5 = future uncertainty discount
  if adjusted > best_adjusted:
    best_word = word; best_adjusted = adjusted

return best_word
```

Leave discount = 0.5 prevents burning high-value tiles (e.g., J) in a 1× word when they could enable a 3× word later.

---

### Step 5: computeBagRemaining() (index.ts)

```typescript
const DEFAULT_BAG: Record<string, number> = {
  A:9,B:2,C:2,D:4,E:12,F:2,G:3,H:2,I:9,J:1,K:1,L:4,
  M:2,N:6,O:8,P:2,Q:1,R:6,S:4,T:6,U:4,V:2,W:2,X:1,Y:2,Z:1
};
const STARTING_RACK_SIZE = 5; // matches server constant
```

```
bag = copy of DEFAULT_BAG

// Only subtract WON auctions.
// CRITICAL: winnerBotId === null means the letter was returned to the bag
// via return_to_bag(). Do NOT subtract those — they're still available.
for result in auction_result where result.matchId === matchId:
  if result.winnerBotId != null:
    bag[result.letter] -= 1

// Subtract the currently open auction letter (drawn from bag, not yet settled)
for auction in open auctions where auction.matchId === matchId:
  bag[auction.letter] -= 1

// Subtract our own rack (definitely consumed from bag)
for [letter, count] in myRack:
  bag[letter] -= count

// Estimate opponents' starting racks (proportional approximation — we can't see them)
const numOthers = numParticipants - 1
const unknownTiles = numOthers * STARTING_RACK_SIZE
for [letter, defaultCount] of Object.entries(DEFAULT_BAG):
  const proportion = defaultCount / 98
  bag[letter] -= Math.round(proportion * unknownTiles)

// Clamp to 0
return new Map(Object.entries(bag).map(([k, v]) => [k, Math.max(0, v)]))
```

---

### Step 6: index.ts changes

**Startup** — build trie; dictionary sort no longer needed (trie handles ordering):
```typescript
import { buildTrie } from "./strategy.js";
const TRIE = buildTrie(DICTIONARY);
```

**Updated `tryBid()`** — gather enriched context before calling `decideBid`:
```typescript
const myRack       = rackForMatch(conn, matchId);
const bagRemaining = computeBagRemaining(conn, matchId, myBotId!, myRack);
const bagTotal     = Number(conn.db.match_state.id.find(matchId)?.bagTotal ?? 0);
const numPart      = [...conn.db.match_participant.iter()]
                       .filter(p => p.matchId === matchId).length;

const amount = decideBid({
  letter, myBalance: participant.balance, myRack,
  trie: TRIE, bagRemaining, bagTotal, numParticipants: numPart,
});
```

**Updated `tryPlayWord()`**:
```typescript
const word = chooseWord({ myRack: rackForMatch(conn, matchId), trie: TRIE });
```

---

## Verification Checklist

1. `npx tsc --noEmit` — no compile errors
2. Trie build time < 2s (logged at startup, one-time cost)
3. `decideBid` compute time < 400ms (log before/after; 150 sims × 2 trie queries)
4. `computeTotalReward("QUARTZ")` = 90: base = 10+1+1+4+10+10 = 36, 6-letter → floor(36×5/2) = 90 ✓
5. Bot bids 0 on Q/Z early game if no complementary tiles in rack
6. Bot bids higher on scarce letters as bag depletes
7. `chooseWord` picks a higher-reward shorter word over a lower-reward longer word
8. Bot never bids more than its balance

---

## Common Pitfalls

- **Do NOT subtract returned letters from bag estimate** — `auction_result` rows with `winnerBotId === null` mean the letter went back via `return_to_bag()`. Only subtract rows where `winnerBotId != null`.
- **Integer division** — `computeTotalReward` must use `Math.floor`, not floating-point multiply, to match Rust's `base * num / denom`.
- **Trie mutation during DFS** — `bestReward` modifies rack counts in-place and restores them. Never call it with a rack you're simultaneously reading elsewhere without copying.
- **`my_rack` is cross-match** — always filter by `matchId` when reading holdings (done in `rackForMatch`).
- **Never edit `module_bindings/`** — regenerate with `spacetime generate` if the schema changes.
