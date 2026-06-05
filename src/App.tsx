import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { useAuth } from "react-oidc-context";
import { ConnectionProvider, useConn } from "./connection";
import Home from "./pages/Home";
import Matches from "./pages/Matches";
import MatchView from "./pages/MatchView";
import Register from "./pages/Register";
import Leaderboard from "./pages/Leaderboard";
import Docs from "./pages/Docs";
import Tournament from "./pages/Tournament";
import Admin from "./pages/Admin";

function Nav() {
  const { connected, dbName } = useConn();
  const auth = useAuth();
  return (
    <nav className="nav">
      <Link to="/" className="brand">Wordsmith</Link>
      <Link to="/matches">Matches</Link>
      <Link to="/leaderboard">Leaderboard</Link>
      <Link to="/tournament">Tournament</Link>
      <Link to="/docs">Docs</Link>
      <Link to="/register">Team</Link>
      <Link to="/admin">Admin</Link>
      <span className="conn-state">
        {connected ? "● connected" : "○ connecting"} · {dbName}
      </span>
      {auth.isAuthenticated ? (
        <span className="auth-state">
          {auth.user?.profile.email ?? auth.user?.profile.preferred_username ?? "signed in"}
          {" · "}
          <a href="#" onClick={(e) => { e.preventDefault(); auth.removeUser(); }}>sign out</a>
        </span>
      ) : (
        <span className="auth-state">
          <a href="#" onClick={(e) => { e.preventDefault(); auth.signinRedirect(); }}>sign in</a>
        </span>
      )}
    </nav>
  );
}

// Renders during the brief OIDC code-exchange. AuthProvider handles the
// exchange via onSigninCallback in main.tsx; after that we strip the URL
// params, so refreshing /callback just shows this stub momentarily.
function Callback() {
  const auth = useAuth();
  if (auth.error) {
    return (
      <div className="page">
        <div className="header full">
          <h1>Sign-in failed</h1>
        </div>
        <section className="panel full">
          <p style={{ color: "var(--warn)" }}>{auth.error.message}</p>
          <Link to="/">Back to home</Link>
        </section>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="header full">
        <h1>Signing in…</h1>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ConnectionProvider>
      <BrowserRouter>
        <Nav />
        <div className="page">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/matches" element={<Matches />} />
            <Route path="/matches/:id" element={<MatchView />} />
            <Route path="/register" element={<Register />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/tournament" element={<Tournament />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/callback" element={<Callback />} />
          </Routes>
        </div>
      </BrowserRouter>
    </ConnectionProvider>
  );
}
