import { useState, type FormEvent } from "react";
import { defaultSetPassword } from "../lib/auth-api";

export interface SetPasswordScreenProps {
  id: string;
  secret: string;
  setPassword?: (id: string, secret: string, password: string) => Promise<void>;
  navigate?: (path: string) => void;
}

export async function submitSetPassword({
  id,
  secret,
  password,
  confirmPassword,
  setPassword,
}: {
  id: string;
  secret: string;
  password: string;
  confirmPassword: string;
  setPassword: (id: string, secret: string, password: string) => Promise<void>;
}): Promise<void> {
  if (password !== confirmPassword) throw new Error("Passwords do not match.");
  await setPassword(id, secret, password);
}

export function SetPasswordScreen({
  id,
  secret,
  setPassword = defaultSetPassword,
  navigate = (path) => {
    window.location.assign(path);
  },
}: SetPasswordScreenProps) {
  const [password, setPasswordValue] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submitSetPassword({ id, secret, password, confirmPassword, setPassword });
      setComplete(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password could not be set.");
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
        {complete ? (
          <div className="odos-login-form">
            <p className="odos-login-confirmation" role="status">Your password is ready.</p>
            <button type="button" onClick={() => navigate("/")}>Password set — sign in</button>
          </div>
        ) : (
          <form className="odos-login-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPasswordValue(event.target.value)}
                placeholder="New password"
              />
            </label>
            <label>
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Confirm new password"
              />
            </label>
            {error && <p className="odos-login-error" role="alert">{error}</p>}
            <button type="submit" disabled={busy}>{busy ? "Setting password…" : "Set password"}</button>
          </form>
        )}
        <p className="odos-login-foot">Your practice · Your hardware · Your data</p>
      </div>
    </main>
  );
}
