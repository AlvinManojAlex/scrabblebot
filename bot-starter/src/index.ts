// Wordsmith bot starter.
//
// Before running:
//   1. `spacetime publish wordsmith --module-path ../spacetimedb`
//   2. `npm run generate`  (creates ./src/module_bindings)
//   3. Set BOT_NAME / STDB_DB / STDB_HOST via env if needed.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { chooseWord, decideBid } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "wordsmith-gf28z";
const BOT_NAME = process.env.BOT_NAME ?? `bot-${Math.floor(Math.random() * 10000)}`;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8");
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick

let myIdentity: Identity | null = null;
const bidsByAuction = new Set<string>(); // remember which auctions we've bid on
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

// Pull this bot's rack scoped to a specific match.
function rackForMatch(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.my_rack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

// Find this bot's MatchParticipant entry for a given match.
function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (!myIdentity) return null;
  for (const p of conn.db.match_participant.iter()) {
    if (p.matchId !== matchId) continue;
    if (!p.bot.isEqual(myIdentity)) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return; // not in this match
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
  });
  if (amount <= 0) return;
  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) });
  bidsByAuction.add(key);
  console.log(`[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`);
}

// Try a word play in every match this bot is participating in.
function tryPlayWord(conn: DbConnection) {
  if (!myIdentity) return;
  const matches = new Set<bigint>();
  for (const p of conn.db.match_participant.iter()) {
    if (p.bot.isEqual(myIdentity)) matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    const word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
    });
    if (!word) continue;
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
    conn.reducers.submitWord({ matchId, word });
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);
      const existing = conn.db.bot.identity.find(identity);
      if (!existing) {
        console.log(`[${BOT_NAME}] registering as '${BOT_NAME}'`);
        conn.reducers.registerBot({ name: BOT_NAME });
      }
      // Bid on any open auctions we're a participant in.
      for (const a of conn.db.auction.iter()) {
        if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
      }
      tryPlayWord(conn);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.my_rack.onInsert(() => tryPlayWord(conn));
  conn.db.my_rack.onUpdate(() => tryPlayWord(conn));

  conn.db.auction_result.onInsert((_ctx, r) => {
    const winner = r.winner ? r.winner.toHexString().slice(0, 8) : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → ${winner} (bid ${r.topBid}, paid ${r.paid})`,
    );
  });
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
