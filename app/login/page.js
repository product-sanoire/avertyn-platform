"use client";
import { useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  async function send(e) {
    e.preventDefault();
    setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: typeof window !== "undefined" ? window.location.origin + "/dashboard" : undefined },
    });
    if (error) setErr(error.message);
    else setSent(true);
  }

  return (
    <div className="card">
      <h1>Sign in</h1>
      {sent ? (
        <p>Check your email for a magic link, then return here.</p>
      ) : (
        <form onSubmit={send}>
          <p>We&apos;ll email you a one-time sign-in link.</p>
          <input
            type="email"
            required
            placeholder="you@tpa.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn" type="submit">Send magic link</button>
          {err && <p className="muted" style={{ color: "var(--red)", marginTop: 10 }}>{err}</p>}
        </form>
      )}
    </div>
  );
}
