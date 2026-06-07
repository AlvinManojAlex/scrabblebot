// ScrabbleBot bot starter.
//
// First run (claim a credential):
//   1. From the website, your team mints a nonce. Or from CLI:
//      `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. Run the bot with the nonce:
//      `BOT_NONCE=<code> npm start`
//      The bot connects fresh, redeems the nonce, and persists its token
//      to .token (so future runs don't need the nonce).
//
// Subsequent runs:
//   `npm start`  -- uses the saved token.
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
import { chooseWord, decideBid, MIN_WORD_SCORE, MAX_RACK_LETTERS } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_NONCE = process.env.BOT_NONCE; // only used on first run
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
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
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const auctionCountByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.bot_credential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.my_rack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.match_participant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const matchState = conn.db.match_state.id.find(matchId);
  const auctionType = matchState?.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey";
  const participantCount = Array.from(conn.db.match_participant.iter()).filter(
    (p) => p.matchId === matchId,
  ).length;
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
    dictionary: DICTIONARY,
    auctionType,
    participantCount,
    auctionIndex: auctionCountByMatch.get(String(matchId)) ?? 0,
  });
  if (amount <= 0) return;
  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch((err: Error) => {
    console.warn(`[${BOT_NAME}] bid rejected (match ${matchId}, auction ${auctionId}): ${err.message}`);
  });
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  const matches = new Set<bigint>();
  for (const p of conn.db.match_participant.iter()) {
    if (p.botId === myBotId) matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const state = conn.db.match_state.id.find(matchId);
    if (state?.status.tag !== "Running") continue;
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    const rack = rackForMatch(conn, matchId);
    const rackSize = Array.from(rack.values()).reduce((a, n) => a + n, 0);
    // If rack is full, accept any playable word to unblock bidding.
    const minScore = rackSize >= MAX_RACK_LETTERS ? 0 : MIN_WORD_SCORE;
    const word = chooseWord({
      myRack: rack,
      dictionary: DICTIONARY,
      minScore,
    });
    if (!word) continue;
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
    conn.reducers.submitWord({ matchId, word }).catch((err: Error) => {
      console.warn(`[${BOT_NAME}] word rejected (match ${matchId}, '${word}'): ${err.message}`);
    });
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

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers.claimCredential({ code: BOT_NONCE });
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(`[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
      bootstrapActivity(conn);
    })
    .subscribe([
      "SELECT * FROM match_state",
      "SELECT * FROM match_participant",
      "SELECT * FROM auction",
      "SELECT * FROM auction_result",
      "SELECT * FROM my_rack",
      "SELECT * FROM bot_credential",
      "SELECT * FROM bot",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag !== "Open") return;
    const matchState = conn.db.match_state.id.find(a.matchId);
    if (matchState?.status.tag !== "Running") return;
    tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.my_rack.onInsert(() => tryPlayWord(conn));
  conn.db.my_rack.onUpdate(() => tryPlayWord(conn));
  conn.db.bot_credential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auction_result.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const matchState = conn.db.match_state.id.find(r.matchId);
    if (matchState?.status.tag !== "Running") return;
    const matchKey = String(r.matchId);
    auctionCountByMatch.set(matchKey, (auctionCountByMatch.get(matchKey) ?? 0) + 1);
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid} (auction #${auctionCountByMatch.get(matchKey)})`,
    );
    // Bid on the next open auction immediately — N+1 may already be in the
    // local table as part of the same server transaction batch, before the
    // separate auction.onInsert event fires.
    for (const a of conn.db.auction.iter()) {
      if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
    }
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.match_state.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.match_participant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        auctionCountByMatch.delete(String(neu.id));
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.match_participant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.match_state.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobby_member.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({});
}

function bootstrapActivity(conn: DbConnection) {
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
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
