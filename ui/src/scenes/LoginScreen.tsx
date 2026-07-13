import { useState, type FormEvent } from "react";
import { fhir } from "../lib/fhir";
import {
  PasswordResetTransportError,
  defaultResetPassword,
} from "../lib/auth-api";

export interface LoginScreenProps {
  returnTo: string;
  onAuthenticated: () => void;
  login?: (email: string, password: string) => Promise<void>;
  resetPassword?: (email: string) => Promise<void>;
  navigate?: (path: string) => void;
}

export const PASSWORD_RESET_CONFIRMATION = "If that account exists, a reset email is on its way";

export async function requestPasswordReset(
  email: string,
  resetPassword: (email: string) => Promise<void>,
): Promise<string> {
  try {
    await resetPassword(email);
  } catch (error) {
    if (error instanceof PasswordResetTransportError) throw error;
  }
  return PASSWORD_RESET_CONFIRMATION;
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
  resetPassword = defaultResetPassword,
  navigate = (path) => {
    window.history.replaceState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
}: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

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

  async function handlePasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResetBusy(true);
    setResetError(null);
    try {
      const confirmation = await requestPasswordReset(resetEmail, resetPassword);
      setResetConfirmation(confirmation);
    } catch (error) {
      setResetError(error instanceof Error ? error.message : "The reset request could not reach ODOS.");
    } finally {
      setResetBusy(false);
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
        <div className="odos-forgot-password">
          {!forgotOpen && !resetConfirmation && (
            <button type="button" onClick={() => setForgotOpen(true)}>Forgot password?</button>
          )}
          {forgotOpen && !resetConfirmation && (
            <form className="odos-login-form" onSubmit={(event) => void handlePasswordReset(event)}>
              <label>
                <span>Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={resetEmail}
                  onChange={(event) => setResetEmail(event.target.value)}
                  placeholder="Email address"
                />
              </label>
              <button type="submit" disabled={resetBusy}>{resetBusy ? "Sending…" : "Send reset link"}</button>
              {resetError && <p className="odos-login-error" role="alert">{resetError}</p>}
            </form>
          )}
          {resetConfirmation && <p className="odos-login-confirmation" role="status">{resetConfirmation}</p>}
        </div>
        <p className="odos-login-foot">Your practice · Your hardware · Your data</p>
      </div>
    </main>
  );
}
