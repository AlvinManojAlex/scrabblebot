mod dictionary;
mod letters;

use std::time::Duration;

use rand::Rng;
use spacetimedb::{
    reducer, table, view, Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp,
    ViewContext,
};

const STARTING_BALANCE: i64 = 100;
const AUCTION_DURATION_MS: u64 = 1000;
// Reserve price for a Vickrey auction with a single bidder.
const AUCTION_RESERVE: i64 = 1;

// ---------- Enums ----------

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum MatchStatus {
    Lobby,
    Running,
    Ended,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AuctionStatus {
    Open,
    Closed,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AuctionType {
    FirstPrice,
    Vickrey,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum BotStrategy {
    Human,
    Cheapskate,
    ValueBidder,
    Aggressive,
}

// ---------- Tables ----------

// Bot — global registration. No per-match state lives here anymore.
#[table(accessor = bot, public)]
pub struct Bot {
    #[primary_key]
    pub identity: Identity,
    #[unique]
    pub name: String,
    pub connected: bool,
    pub registered_at: Timestamp,
    pub is_simulated: bool,
    pub strategy: BotStrategy,
}

// Match — one row per match. Replaces the old singleton MatchState.
#[table(
    accessor = match_state,
    public,
    index(accessor = match_by_status, btree(columns = [status]))
)]
pub struct Match {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub status: MatchStatus,
    pub current_round: u32,
    pub current_auction_id: Option<u64>,
    pub bag_total: u32,
    pub auction_type: AuctionType,
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
}

// Per-match balance and score for one bot in one match.
#[table(
    accessor = match_participant,
    public,
    index(accessor = mp_by_match, btree(columns = [match_id])),
    index(accessor = mp_by_bot, btree(columns = [bot]))
)]
pub struct MatchParticipant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot: Identity,
    pub balance: i64,
    pub score: i64,
}

// Private — each match has its own bag.
#[table(
    accessor = bag_letter,
    index(accessor = bag_by_match, btree(columns = [match_id]))
)]
pub struct BagLetter {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub letter: String,
    pub remaining: u32,
}

// Private — each bot sees only their own rack via `my_rack`.
#[table(
    accessor = holding,
    index(accessor = holding_by_bot, btree(columns = [bot])),
    index(accessor = holding_by_match, btree(columns = [match_id]))
)]
pub struct Holding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot: Identity,
    pub letter: String,
    pub count: u32,
}

#[table(
    accessor = auction,
    public,
    index(accessor = auction_by_match, btree(columns = [match_id])),
    index(accessor = auction_by_status, btree(columns = [status]))
)]
pub struct Auction {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub letter: String,
    pub opens_at: Timestamp,
    pub closes_at: Timestamp,
    pub status: AuctionStatus,
}

// Private — bots cannot subscribe and so cannot see competing bids.
#[table(
    accessor = pending_bid,
    index(accessor = bid_by_auction, btree(columns = [auction_id]))
)]
pub struct PendingBid {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub auction_id: u64,
    pub bidder: Identity,
    pub amount: i64,
    pub submitted_at: Timestamp,
}

#[table(
    accessor = auction_result,
    public,
    index(accessor = result_by_match, btree(columns = [match_id]))
)]
pub struct AuctionResult {
    #[primary_key]
    pub auction_id: u64,
    pub match_id: u64,
    pub letter: String,
    pub winner: Option<Identity>,
    pub top_bid: i64,
    pub paid: i64,
    pub closed_at: Timestamp,
}

#[table(
    accessor = word_play,
    public,
    index(accessor = play_by_match, btree(columns = [match_id])),
    index(accessor = play_by_bot, btree(columns = [bot]))
)]
pub struct WordPlay {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot: Identity,
    pub word: String,
    pub base_score: i64,
    pub bonus: i64,
    pub total_reward: i64,
    pub played_at: Timestamp,
}

#[table(accessor = auction_schedule, scheduled(auction_tick))]
pub struct AuctionSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub match_id: u64,
}

// ---------- Views ----------

// A bot sees only its own letters (across any matches it's in). Clients
// filter by match_id on their side.
#[view(accessor = my_rack, public)]
fn my_rack(ctx: &ViewContext) -> Vec<Holding> {
    ctx.db
        .holding()
        .holding_by_bot()
        .filter(ctx.sender())
        .collect()
}

// ---------- Lifecycle ----------

#[reducer(init)]
pub fn init(_ctx: &ReducerContext) {
    // Nothing global to bootstrap — matches and bags are per-match now.
}

#[reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    if let Some(bot) = ctx.db.bot().identity().find(ctx.sender()) {
        ctx.db.bot().identity().update(Bot {
            connected: true,
            ..bot
        });
    }
}

#[reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    if let Some(bot) = ctx.db.bot().identity().find(ctx.sender()) {
        ctx.db.bot().identity().update(Bot {
            connected: false,
            ..bot
        });
    }
}

// ---------- Bot management ----------

#[reducer]
pub fn register_bot(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err("Name must be 1-32 characters".into());
    }
    if ctx.db.bot().identity().find(ctx.sender()).is_some() {
        return Err("This identity is already registered".into());
    }
    if ctx.db.bot().name().find(trimmed.to_string()).is_some() {
        return Err("Name already taken".into());
    }
    ctx.db.bot().insert(Bot {
        identity: ctx.sender(),
        name: trimmed.to_string(),
        connected: true,
        registered_at: ctx.timestamp,
        is_simulated: false,
        strategy: BotStrategy::Human,
    });
    log::info!("Bot registered: {}", trimmed);
    Ok(())
}

#[reducer]
pub fn spawn_simulated_bot(
    ctx: &ReducerContext,
    name: String,
    strategy: BotStrategy,
) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err("Name must be 1-32 characters".into());
    }
    if matches!(strategy, BotStrategy::Human) {
        return Err("Simulated bots cannot use the Human strategy".into());
    }
    if ctx.db.bot().name().find(trimmed.to_string()).is_some() {
        return Err("Name already taken".into());
    }
    let identity = Identity::from_claims("sim", trimmed);
    if ctx.db.bot().identity().find(identity).is_some() {
        return Err("Simulated bot already exists".into());
    }
    ctx.db.bot().insert(Bot {
        identity,
        name: trimmed.to_string(),
        connected: true,
        registered_at: ctx.timestamp,
        is_simulated: true,
        strategy,
    });
    log::info!("Simulated bot spawned: {}", trimmed);
    Ok(())
}

// ---------- Match control ----------

// Start a match with every currently-registered bot.
#[reducer]
pub fn start_match(ctx: &ReducerContext, auction_type: AuctionType) -> Result<(), String> {
    let participants: Vec<Identity> = ctx.db.bot().iter().map(|b| b.identity).collect();
    start_match_with(ctx, auction_type, participants)
}

// Start a match with a specific roster.
#[reducer]
pub fn start_match_for(
    ctx: &ReducerContext,
    auction_type: AuctionType,
    participants: Vec<Identity>,
) -> Result<(), String> {
    start_match_with(ctx, auction_type, participants)
}

fn start_match_with(
    ctx: &ReducerContext,
    auction_type: AuctionType,
    participants: Vec<Identity>,
) -> Result<(), String> {
    if participants.is_empty() {
        return Err("Need at least one participant".into());
    }
    let bag_total: u32 = letters::DEFAULT_BAG.iter().map(|(_, c)| c).sum();
    let m = ctx.db.match_state().insert(Match {
        id: 0,
        status: MatchStatus::Running,
        current_round: 1,
        current_auction_id: None,
        bag_total,
        auction_type,
        created_at: ctx.timestamp,
        started_at: Some(ctx.timestamp),
        ended_at: None,
    });
    let match_id = m.id;

    for identity in &participants {
        if ctx.db.bot().identity().find(*identity).is_none() {
            return Err(format!("Unknown bot in roster: {}", identity.to_hex()));
        }
        ctx.db.match_participant().insert(MatchParticipant {
            id: 0,
            match_id,
            bot: *identity,
            balance: STARTING_BALANCE,
            score: 0,
        });
    }

    for (letter, count) in letters::DEFAULT_BAG.iter() {
        ctx.db.bag_letter().insert(BagLetter {
            id: 0,
            match_id,
            letter: letter.to_string(),
            remaining: *count,
        });
    }

    let first_letter = draw_letter(ctx, match_id).ok_or("Bag empty")?;
    let opens_at = ctx.timestamp;
    let closes_at = ctx.timestamp + Duration::from_millis(AUCTION_DURATION_MS);
    let auction = ctx.db.auction().insert(Auction {
        id: 0,
        match_id,
        letter: first_letter,
        opens_at,
        closes_at,
        status: AuctionStatus::Open,
    });

    let m = ctx.db.match_state().id().find(match_id).unwrap();
    ctx.db.match_state().id().update(Match {
        current_auction_id: Some(auction.id),
        ..m
    });

    ctx.db.auction_schedule().insert(AuctionSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(closes_at),
        match_id,
    });

    simulate_bids(ctx, &auction);

    log::info!(
        "Match {} started with {} participants",
        match_id,
        participants.len()
    );
    Ok(())
}

// ---------- Bidding ----------

#[reducer]
pub fn submit_bid(ctx: &ReducerContext, auction_id: u64, amount: i64) -> Result<(), String> {
    if amount < 0 {
        return Err("Bid must be non-negative".into());
    }
    let auction = ctx
        .db
        .auction()
        .id()
        .find(auction_id)
        .ok_or("Unknown auction")?;
    if auction.status != AuctionStatus::Open {
        return Err("Auction closed".into());
    }
    if ctx.timestamp >= auction.closes_at {
        return Err("Auction window expired".into());
    }
    let participant =
        find_participant(ctx, auction.match_id, ctx.sender()).ok_or("Not in this match")?;
    if participant.balance < amount {
        return Err("Insufficient balance".into());
    }

    let existing: Vec<u64> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(auction_id)
        .filter(|b| b.bidder == ctx.sender())
        .map(|b| b.id)
        .collect();
    for id in existing {
        ctx.db.pending_bid().id().delete(id);
    }

    ctx.db.pending_bid().insert(PendingBid {
        id: 0,
        auction_id,
        bidder: ctx.sender(),
        amount,
        submitted_at: ctx.timestamp,
    });
    Ok(())
}

// ---------- Word play ----------

#[reducer]
pub fn submit_word(ctx: &ReducerContext, match_id: u64, word: String) -> Result<(), String> {
    let m = ctx
        .db
        .match_state()
        .id()
        .find(match_id)
        .ok_or("Unknown match")?;
    if m.status != MatchStatus::Running {
        return Err("Match not running".into());
    }
    let participant =
        find_participant(ctx, match_id, ctx.sender()).ok_or("Not in this match")?;

    let word_upper = word.to_ascii_uppercase();
    if word_upper.len() < 2 {
        return Err("Word must be at least 2 letters".into());
    }
    if !word_upper.chars().all(|c| c.is_ascii_uppercase()) {
        return Err("Word must be A-Z only".into());
    }
    if !dictionary::is_valid_word(&word_upper) {
        return Err(format!("'{}' is not in the dictionary", word_upper));
    }

    play_word(ctx, participant, &word_upper)
}

// ---------- Auction tick (scheduled) ----------

#[reducer]
pub fn auction_tick(ctx: &ReducerContext, job: AuctionSchedule) {
    let match_id = job.match_id;
    let m = match ctx.db.match_state().id().find(match_id) {
        Some(m) if m.status == MatchStatus::Running => m,
        _ => return,
    };
    let Some(auction_id) = m.current_auction_id else {
        return;
    };
    let Some(auction) = ctx.db.auction().id().find(auction_id) else {
        return;
    };

    let bids: Vec<PendingBid> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(auction_id)
        .collect();
    let mut sorted: Vec<&PendingBid> = bids.iter().filter(|b| b.amount > 0).collect();
    sorted.sort_by(|a, b| b.amount.cmp(&a.amount).then(a.id.cmp(&b.id)));

    let (winner, top_bid, paid) = match (m.auction_type.clone(), sorted.as_slice()) {
        (_, []) => (None, 0, 0),
        (AuctionType::FirstPrice, [only]) => (Some(only.bidder), only.amount, only.amount),
        (AuctionType::FirstPrice, [first, ..]) => (Some(first.bidder), first.amount, first.amount),
        (AuctionType::Vickrey, [only]) => {
            (Some(only.bidder), only.amount, AUCTION_RESERVE.min(only.amount))
        }
        (AuctionType::Vickrey, [first, second, ..]) => {
            (Some(first.bidder), first.amount, second.amount)
        }
    };

    let mut sim_winner: Option<Identity> = None;
    if let Some(w) = winner {
        if let Some(participant) = find_participant(ctx, match_id, w) {
            if participant.balance >= paid {
                let bot_is_sim = ctx
                    .db
                    .bot()
                    .identity()
                    .find(w)
                    .map(|b| b.is_simulated)
                    .unwrap_or(false);
                let new_balance = participant.balance - paid;
                ctx.db.match_participant().id().update(MatchParticipant {
                    balance: new_balance,
                    ..participant
                });
                let existing: Vec<Holding> = ctx
                    .db
                    .holding()
                    .holding_by_bot()
                    .filter(w)
                    .filter(|h| h.match_id == match_id && h.letter == auction.letter)
                    .collect();
                if let Some(h) = existing.into_iter().next() {
                    ctx.db.holding().id().update(Holding {
                        count: h.count + 1,
                        ..h
                    });
                } else {
                    ctx.db.holding().insert(Holding {
                        id: 0,
                        match_id,
                        bot: w,
                        letter: auction.letter.clone(),
                        count: 1,
                    });
                }
                if bot_is_sim {
                    sim_winner = Some(w);
                }
            }
        }
    } else {
        return_to_bag(ctx, match_id, &auction.letter);
    }

    ctx.db.auction_result().insert(AuctionResult {
        auction_id,
        match_id,
        letter: auction.letter.clone(),
        winner,
        top_bid,
        paid,
        closed_at: ctx.timestamp,
    });
    ctx.db.auction().id().update(Auction {
        status: AuctionStatus::Closed,
        ..auction
    });
    for b in bids {
        ctx.db.pending_bid().id().delete(b.id);
    }

    if let Some(w) = sim_winner {
        simulate_word_play(ctx, match_id, w);
    }

    let m2 = ctx.db.match_state().id().find(match_id).unwrap();
    let next_letter = match draw_letter(ctx, match_id) {
        Some(l) => l,
        None => {
            ctx.db.match_state().id().update(Match {
                status: MatchStatus::Ended,
                current_auction_id: None,
                ended_at: Some(ctx.timestamp),
                ..m2
            });
            log::info!("Match {} ended (bag empty)", match_id);
            return;
        }
    };

    let opens_at = ctx.timestamp;
    let closes_at = ctx.timestamp + Duration::from_millis(AUCTION_DURATION_MS);
    let next_auction = ctx.db.auction().insert(Auction {
        id: 0,
        match_id,
        letter: next_letter,
        opens_at,
        closes_at,
        status: AuctionStatus::Open,
    });

    let m3 = ctx.db.match_state().id().find(match_id).unwrap();
    ctx.db.match_state().id().update(Match {
        current_round: m3.current_round + 1,
        current_auction_id: Some(next_auction.id),
        ..m3
    });
    ctx.db.auction_schedule().insert(AuctionSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(closes_at),
        match_id,
    });

    simulate_bids(ctx, &next_auction);
}

// ---------- Helpers ----------

fn find_participant(
    ctx: &ReducerContext,
    match_id: u64,
    bot: Identity,
) -> Option<MatchParticipant> {
    ctx.db
        .match_participant()
        .mp_by_match()
        .filter(match_id)
        .find(|p| p.bot == bot)
}

fn play_word(
    ctx: &ReducerContext,
    participant: MatchParticipant,
    word_upper: &str,
) -> Result<(), String> {
    let match_id = participant.match_id;
    let bot_identity = participant.bot;

    let mut needed: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for c in word_upper.chars() {
        *needed.entry(c).or_insert(0) += 1;
    }

    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(bot_identity)
        .filter(|h| h.match_id == match_id)
        .collect();
    let mut by_letter: std::collections::HashMap<char, (u64, u32)> =
        std::collections::HashMap::new();
    for h in &holdings {
        if let Some(c) = h.letter.chars().next() {
            by_letter.insert(c, (h.id, h.count));
        }
    }
    for (c, n) in &needed {
        let have = by_letter.get(c).map(|(_, ct)| *ct).unwrap_or(0);
        if have < *n {
            return Err(format!("Not enough '{}': need {}, have {}", c, n, have));
        }
    }

    for (c, n) in &needed {
        let (hid, ct) = by_letter[c];
        let new_ct = ct - n;
        if new_ct == 0 {
            ctx.db.holding().id().delete(hid);
        } else if let Some(h) = ctx.db.holding().id().find(hid) {
            ctx.db.holding().id().update(Holding {
                count: new_ct,
                ..h
            });
        }
    }

    let base_score: i64 = word_upper
        .chars()
        .map(|c| letters::letter_value(c) as i64)
        .sum();
    let (num, denom) = letters::length_multiplier(word_upper.len());
    let total_reward = base_score * num / denom;
    let bonus = total_reward - base_score;

    let new_balance = participant.balance + total_reward;
    let new_score = participant.score + total_reward;
    ctx.db.match_participant().id().update(MatchParticipant {
        balance: new_balance,
        score: new_score,
        ..participant
    });

    ctx.db.word_play().insert(WordPlay {
        id: 0,
        match_id,
        bot: bot_identity,
        word: word_upper.to_string(),
        base_score,
        bonus,
        total_reward,
        played_at: ctx.timestamp,
    });

    log::info!(
        "[match {}] '{}' played: base={}, bonus={}, total={}",
        match_id,
        word_upper,
        base_score,
        bonus,
        total_reward
    );
    Ok(())
}

fn draw_letter(ctx: &ReducerContext, match_id: u64) -> Option<String> {
    let m = ctx.db.match_state().id().find(match_id)?;
    if m.bag_total == 0 {
        return None;
    }
    let mut idx: u32 = ctx.rng().gen_range(0..m.bag_total);
    let mut entries: Vec<BagLetter> = ctx
        .db
        .bag_letter()
        .bag_by_match()
        .filter(match_id)
        .filter(|b| b.remaining > 0)
        .collect();
    entries.sort_by(|a, b| a.letter.cmp(&b.letter));
    for bag in &entries {
        if idx < bag.remaining {
            let letter = bag.letter.clone();
            let new_remaining = bag.remaining - 1;
            let bag_id = bag.id;
            let bag_match_id = bag.match_id;
            ctx.db.bag_letter().id().update(BagLetter {
                id: bag_id,
                match_id: bag_match_id,
                letter: letter.clone(),
                remaining: new_remaining,
            });
            ctx.db.match_state().id().update(Match {
                bag_total: m.bag_total - 1,
                ..m
            });
            return Some(letter);
        }
        idx -= bag.remaining;
    }
    None
}

fn return_to_bag(ctx: &ReducerContext, match_id: u64, letter: &str) {
    let entry = ctx
        .db
        .bag_letter()
        .bag_by_match()
        .filter(match_id)
        .find(|b| b.letter == letter);
    if let Some(bag) = entry {
        ctx.db.bag_letter().id().update(BagLetter {
            remaining: bag.remaining + 1,
            ..bag
        });
    } else {
        ctx.db.bag_letter().insert(BagLetter {
            id: 0,
            match_id,
            letter: letter.to_string(),
            remaining: 1,
        });
    }
    if let Some(m) = ctx.db.match_state().id().find(match_id) {
        ctx.db.match_state().id().update(Match {
            bag_total: m.bag_total + 1,
            ..m
        });
    }
}

// ---------- Simulated-bot logic ----------

fn decide_bid(strategy: &BotStrategy, letter: &str, balance: i64) -> i64 {
    let c = letter.chars().next().unwrap_or('A');
    let value = letters::letter_value(c) as i64;
    let is_vowel = matches!(c, 'A' | 'E' | 'I' | 'O' | 'U');
    let bid = match strategy {
        BotStrategy::Human => return 0,
        BotStrategy::Cheapskate => (value - 1).max(1),
        BotStrategy::ValueBidder => value,
        BotStrategy::Aggressive => value + if is_vowel { 4 } else { 2 },
    };
    bid.min(balance).max(0)
}

fn simulate_bids(ctx: &ReducerContext, auction: &Auction) {
    let participants: Vec<MatchParticipant> = ctx
        .db
        .match_participant()
        .mp_by_match()
        .filter(auction.match_id)
        .collect();
    for p in participants {
        let Some(bot) = ctx.db.bot().identity().find(p.bot) else {
            continue;
        };
        if !bot.is_simulated {
            continue;
        }
        let amount = decide_bid(&bot.strategy, &auction.letter, p.balance);
        if amount <= 0 {
            continue;
        }
        let prior: Vec<u64> = ctx
            .db
            .pending_bid()
            .bid_by_auction()
            .filter(auction.id)
            .filter(|b| b.bidder == bot.identity)
            .map(|b| b.id)
            .collect();
        for id in prior {
            ctx.db.pending_bid().id().delete(id);
        }
        ctx.db.pending_bid().insert(PendingBid {
            id: 0,
            auction_id: auction.id,
            bidder: bot.identity,
            amount,
            submitted_at: ctx.timestamp,
        });
    }
}

fn simulate_word_play(ctx: &ReducerContext, match_id: u64, bot_identity: Identity) {
    let Some(participant) = find_participant(ctx, match_id, bot_identity) else {
        return;
    };
    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(bot_identity)
        .filter(|h| h.match_id == match_id)
        .collect();
    let mut rack: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for h in &holdings {
        if let Some(c) = h.letter.chars().next() {
            *rack.entry(c).or_insert(0) += h.count;
        }
    }
    let Some(word) = dictionary::find_best_playable(&rack, 3) else {
        return;
    };
    let _ = play_word(ctx, participant, &word);
}
