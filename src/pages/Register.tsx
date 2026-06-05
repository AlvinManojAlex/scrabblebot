import { useState } from "react";
import { useAuth } from "react-oidc-context";
import { useConn } from "../connection";
import { DbConnection } from "../module_bindings";
import type { MyTeam, TeamMember } from "../module_bindings/types";

// The /team page: sign in via SpacetimeAuth → create a team (which mints a
// fresh bot identity + token in a background connection, then calls
// create_team) → display the bot token, redisplayable anytime to Owners.
export default function Register() {
  const { conn, identity, version, dbName } = useConn();
  const auth = useAuth();
  void version;

  // ---- not signed in
  if (!auth.isAuthenticated) {
    return (
      <>
        <div className="header full">
          <h1>Team</h1>
        </div>
        <section className="panel full">
          <p>
            Bots are owned by <b>teams</b>. Sign in with SpacetimeAuth (Google / GitHub /
            Discord / etc.), create a team, and you'll get a bot token your whole team can
            share. Any team member with the token can run the bot.
          </p>
          <p style={{ marginTop: 12 }}>
            <button className="button" onClick={() => auth.signinRedirect()}>
              Sign in with SpacetimeAuth
            </button>
          </p>
        </section>
      </>
    );
  }

  // ---- signed in, look up my team via the my_team view
  let myTeam: MyTeam | null = null;
  if (conn) {
    for (const row of conn.db.my_team.iter()) {
      myTeam = row;
      break;
    }
  }

  if (myTeam) {
    return <TeamPanel team={myTeam} />;
  }

  return <CreateOrJoinPanel conn={conn} userEmail={String(auth.user?.profile.email ?? "")} dbName={dbName} myIdentityHex={identity?.toHexString() ?? null} />;
}

function CreateOrJoinPanel({
  conn,
  dbName,
  myIdentityHex,
}: {
  conn: DbConnection | null;
  userEmail: string;
  dbName: string;
  myIdentityHex: string | null;
}) {
  const [mode, setMode] = useState<"create" | "join">("create");
  const [teamName, setTeamName] = useState("");
  const [botName, setBotName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!conn) return;
    setBusy(true);
    setError(null);
    try {
      // Open a separate anonymous connection to mint the bot identity + token.
      const host =
        import.meta.env.VITE_STDB_HOST ?? "https://maincloud.spacetimedb.com";
      await new Promise<void>((resolve, reject) => {
        const botConn = DbConnection.builder()
          .withUri(host)
          .withDatabaseName(dbName)
          // no .withToken — fresh identity
          .onConnect((bc, botIdentity, botToken) => {
            bc.subscriptionBuilder()
              .onApplied(() => {
                bc.reducers.registerBot({ name: botName.trim() });
                // give the row a moment to land, then verify and create team
                setTimeout(() => {
                  const ok = Array.from(bc.db.bot.iter()).some(
                    (b) => b.identity.isEqual(botIdentity) && b.name === botName.trim(),
                  );
                  try { bc.disconnect(); } catch { /* */ }
                  if (!ok) {
                    reject(new Error("Bot name registration didn't take. Name might be taken."));
                    return;
                  }
                  // Now call create_team on our authed connection.
                  conn.reducers.createTeam({
                    teamName: teamName.trim(),
                    botName: botName.trim(),
                    botIdentity,
                    botToken,
                  });
                  resolve();
                }, 800);
              })
              .subscribeToAllTables();
          })
          .onConnectError((_ctx, e) => {
            reject(new Error(`Anonymous bot connection failed: ${e.message}`));
          })
          .build();
        void botConn;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function join() {
    if (!conn) return;
    setBusy(true);
    setError(null);
    conn.reducers.joinTeam({ teamName: teamName.trim() });
    setTimeout(() => setBusy(false), 600);
  }

  return (
    <>
      <div className="header full">
        <h1>Team</h1>
        <span className="status">
          signed in as <code>{myIdentityHex?.slice(0, 12)}…</code>
        </span>
      </div>

      <section className="panel full">
        <div className="row">
          <span>
            <button
              className="button"
              style={{ marginRight: 8, opacity: mode === "create" ? 1 : 0.6 }}
              onClick={() => setMode("create")}
            >
              Create
            </button>
            <button
              className="button"
              style={{ opacity: mode === "join" ? 1 : 0.6 }}
              onClick={() => setMode("join")}
            >
              Join existing
            </button>
          </span>
        </div>
        {mode === "create" ? (
          <>
            <p className="secondary" style={{ marginTop: 12 }}>
              Pick names for your team and your bot. You'll get a bot token your
              teammates can use too — and you can come back any time to re-copy it.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, marginTop: 12, alignItems: "center" }}>
              <span>Team name</span>
              <input
                value={teamName}
                placeholder="e.g. Eagles"
                onChange={(e) => setTeamName(e.target.value)}
                disabled={busy}
                style={inputStyle}
              />
              <span>Bot name</span>
              <input
                value={botName}
                placeholder="e.g. EaglesBot"
                onChange={(e) => setBotName(e.target.value)}
                disabled={busy}
                style={inputStyle}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                className="button"
                disabled={busy || !teamName.trim() || !botName.trim()}
                onClick={create}
              >
                {busy ? "Creating…" : "Create team"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="secondary" style={{ marginTop: 12 }}>
              Enter the name of the team that invited you.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, marginTop: 12, alignItems: "center" }}>
              <span>Team name</span>
              <input
                value={teamName}
                placeholder="e.g. Eagles"
                onChange={(e) => setTeamName(e.target.value)}
                disabled={busy}
                style={inputStyle}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="button" disabled={busy || !teamName.trim()} onClick={join}>
                {busy ? "Joining…" : "Join team"}
              </button>
            </div>
          </>
        )}
        {error && (
          <div style={{ color: "var(--warn)", marginTop: 12 }}>{error}</div>
        )}
      </section>
    </>
  );
}

function TeamPanel({ team }: { team: MyTeam }) {
  const { conn, version } = useConn();
  void version;

  const members: TeamMember[] = [];
  if (conn) {
    for (const m of conn.db.team_member.iter()) {
      if (m.teamId === team.id) members.push(m);
    }
  }
  members.sort((a, b) => Number(a.joinedAt.__timestamp_micros_since_unix_epoch__ - b.joinedAt.__timestamp_micros_since_unix_epoch__));

  function leave() {
    if (!conn) return;
    if (!confirm("Leave this team? If you're the last member, the team is deleted.")) return;
    conn.reducers.leaveTeam({});
  }

  return (
    <>
      <div className="header full">
        <h1>{team.name}</h1>
        <span className="status">
          you are {team.role.tag.toLowerCase()} · bot <b>{team.botName}</b>
        </span>
      </div>

      {team.botToken && (
        <section className="panel full">
          <h2>Bot token</h2>
          <p className="secondary">
            Share this with your teammates. Use it as <code>BOT_TOKEN</code> in the bot
            starter kit. (Only visible to Owners.)
          </p>
          <code style={tokenStyle}>{team.botToken}</code>
        </section>
      )}

      <section className="panel">
        <h2>Members</h2>
        {members.map((m) => (
          <div key={String(m.id)} className="row">
            <div>
              <code>{m.user.toHexString().slice(0, 12)}…</code>
            </div>
            <div className="secondary">{m.role.tag}</div>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Bot details</h2>
        <div className="row">
          <span>Bot name</span>
          <span>{team.botName}</span>
        </div>
        <div className="row">
          <span>Bot identity</span>
          <code>{team.botIdentity.toHexString().slice(0, 12)}…</code>
        </div>
        <div className="row">
          <span>Your role</span>
          <span>{team.role.tag}</span>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="button" onClick={leave}>Leave team</button>
        </div>
      </section>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 10px",
};

const tokenStyle: React.CSSProperties = {
  display: "block",
  wordBreak: "break-all",
  background: "var(--bg)",
  padding: 8,
  borderRadius: 6,
  border: "1px solid var(--border)",
  fontSize: 12,
};
