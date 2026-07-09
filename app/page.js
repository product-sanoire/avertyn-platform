import Link from "next/link";

export default function Home() {
  return (
    <div className="card">
      <h1>Avertyn</h1>
      <p>IDR defense for plans, TPAs & self-funded employers.</p>
      <Link href="/dashboard">
        <button className="btn">Open the command center →</button>
      </Link>
      <p className="muted" style={{ marginTop: 14 }}>
        You&apos;ll be asked to sign in. See the README to attach your account to the demo org.
      </p>
    </div>
  );
}
