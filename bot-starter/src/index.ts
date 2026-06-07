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
import { buildTrie, chooseWord, decideBid, type TrieNode } from "./strategy.js";
// Volume-bidder branch: MC removed, no bag tracking needed for bidding.

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

// Load the shared wordlist and build the trie once at startup.
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

console.log(`[${BOT_NAME}] building trie from ${DICTIONARY.length} words…`);
const t0 = Date.now();
const TRIE: TrieNode = buildTrie(DICTIONARY);
console.log(`[${BOT_NAME}] trie built in ${Date.now() - t0}ms`);


let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const turnsHeldByMatch = new Map<string, number>(); // consecutive holds per match
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

  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
  });

  if (amount <= 0) return;

  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch((err: Error) => {
    console.warn(`[${BOT_NAME}] bid rejected (match ${matchId}, auction ${auctionId}): ${err.message}`);
  });
  bidsByAuction.add(key);
  console.log(`[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`);
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

    const myRack = rackForMatch(conn, matchId);
    const participant = participantForMatch(conn, matchId);
    const bagTotal = Number(conn.db.match_state.id.find(matchId)?.bagTotal ?? 0);
    const turnsHeld = turnsHeldByMatch.get(key) ?? 0;

    const word = chooseWord({
      myRack,
      trie: TRIE,
      myBalance: participant?.balance ?? 0,
      bagTotal,
      turnsHeld,
    });

    if (!word) {
      // Increment held counter only when rack has tiles (genuine hold decision).
      const rackSize = [...myRack.values()].reduce((s, c) => s + c, 0);
      if (rackSize > 0) turnsHeldByMatch.set(key, turnsHeld + 1);
      continue;
    }

    turnsHeldByMatch.set(key, 0); // reset on play
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}' (held ${turnsHeld} turns)`);
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

      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers.claimCredential({ code: BOT_NONCE });
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


  conn.db.match_state.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.match_participant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        turnsHeldByMatch.delete(String(neu.id));
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
  conn.reducers.joinLobby({}).catch((err: Error) => {
    console.log(`[${BOT_NAME}] lobby join skipped: ${err.message}`);
  });
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
