import { useState, type FormEvent } from "react";
import { fhir } from "../lib/fhir";

export interface LoginScreenProps {
  returnTo: string;
  onAuthenticated: () => void;
  login?: (email: string, password: string) => Promise<void>;
  navigate?: (path: string) => void;
}

export async function submitLogin({
  email,
  password,
  returnTo,
  login,
  navigate,
  onAuthenticated,
}: {
  email: string;
  password: string;
  returnTo: string;
  login: (email: string, password: string) => Promise<void>;
  navigate: (path: string) => void;
  onAuthenticated: () => void;
}): Promise<void> {
  await login(email, password);
  navigate(returnTo);
  onAuthenticated();
}

export function LoginScreen({
  returnTo,
  onAuthenticated,
  login = fhir.login,
  navigate = (path) => {
    window.history.replaceState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
}: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submitLogin({ email, password, returnTo, login, navigate, onAuthenticated });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed. Check your email and password.");
      setBusy(false);
    }
  }

  return (
    <main className="odos-login">
      <div className="odos-ambient" aria-hidden="true" />
      <div className="odos-login-content">
        <div className="odos-iris" aria-hidden="true">
          <div className="odos-iris-ring" />
          <div className="odos-iris-inner" />
          <div className="odos-iris-pupil" />
          <div className="odos-iris-glint" />
        </div>
        <div className="odos-login-brand">
          <h1>ODOS <span>20/20</span></h1>
          <p>Own your software · Own your data</p>
        </div>
        <form className="odos-login-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email address"
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
            />
          </label>
          {error && <p className="odos-login-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Enter"}</button>
        </form>
        <p className="odos-login-foot">Your practice · Your hardware · Your data</p>
      </div>
    </main>
  );
}
