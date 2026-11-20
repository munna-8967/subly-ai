import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert } from '../components/ui';
import { api, describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Link, useRouter } from '../lib/router';

/** Sign in / create account. `next` is where to go afterwards (only same-site paths are accepted). */
export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { setAccount } = useAuth();
  const { navigate } = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const register = mode === 'register';
  // Keep the page the visitor wanted while they switch between sign-in and create-account.
  const carry = window.location.search;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const account = register ? await api.register({ email, password, name }) : await api.login({ email, password });
      setAccount(account);
      const next = new URLSearchParams(window.location.search).get('next');
      navigate(next && /^\/(?!\/)/.test(next) ? next : '/', { replace: true });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container auth-wrap">
      <div className="card auth-card">
        <h1 className="auth-title">{register ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted">{register ? 'Every account gets free credits each month. No card needed.' : 'Sign in to open your projects.'}</p>
        {error && <Alert kind="error">{error}</Alert>}
        <form onSubmit={(e) => void submit(e)}>
          {register && (
            <>
              <label htmlFor="auth-name">Name</label>
              <input id="auth-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </>
          )}
          <label htmlFor="auth-email">E-mail</label>
          <input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} />
          {register && <p className="muted small">At least 8 characters.</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
        </form>
        <p className="muted small auth-switch">
          {register ? <>Already have an account? <Link to={`/login${carry}`}>Sign in</Link></> : <>New here? <Link to={`/register${carry}`}>Create an account</Link></>}
        </p>
        {!register && <p className="muted small">Forgot your password? Password reset by e-mail is not built in yet (it needs an e-mail service). The server owner can reset it in the database.</p>}
      </div>
    </div>
  );
}
