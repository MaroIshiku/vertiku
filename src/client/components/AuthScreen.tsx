import { useState, type FormEvent } from 'react';
import { errorMessage, requestJson } from '../api.js';
import type { Session } from '../types.js';

type AuthScreenProps = { setup: boolean; passwordResetEnabled: boolean; notice?: string; onAuthenticated: (session: Session) => void };

export function AuthScreen({ setup, passwordResetEnabled, notice, onAuthenticated }: AuthScreenProps) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [recoveryError, setRecoveryError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const values = new FormData(event.currentTarget);
    try {
      if (setup) await requestJson('/api/setup', { method: 'POST', body: JSON.stringify({ username: values.get('username'), password: values.get('password'), setupSecret: values.get('setupSecret') }) });
      onAuthenticated(await requestJson<Session>('/api/session', { method: 'POST', body: JSON.stringify({ username: values.get('username'), password: values.get('password') }) }));
    } catch (reason) { setError(errorMessage(reason, 'Authentication failed.')); } finally { setBusy(false); }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setRecoveryError(''); setRecoveryMessage('');
    const form = event.currentTarget; const values = new FormData(form);
    try {
      if (values.get('newPassword') !== values.get('confirmPassword')) throw new Error('The new passwords do not match.');
      await requestJson('/api/password-reset', { method: 'POST', body: JSON.stringify({ username: values.get('username'), setupSecret: values.get('setupSecret'), newPassword: values.get('newPassword') }) });
      form.reset();
      setRecoveryMessage('Password reset complete. Sign in above, then set VERTIKU_PASSWORD_RESET back to false and restart Vertiku.');
    } catch (reason) { setRecoveryError(errorMessage(reason, 'Password recovery failed.')); } finally { setBusy(false); }
  }

  return <main className="auth-layout">
    <section className="auth-card" aria-labelledby="auth-title">
      <img className="app-icon" src="/vertiku-icon.png" alt="" width="92" height="92" />
      <p className="eyebrow">VERTIKU</p>
      <h1 id="auth-title">{setup ? 'Create your administrator account' : 'Welcome back'}</h1>
      <p>{setup ? 'Files stay on this server. Use the setup secret configured by the server owner.' : 'Sign in to create and manage your audiobooks.'}</p>
      {notice && <p className="message info" role="status">{notice}</p>}
      <form onSubmit={submit} className="form-stack">
        <label>Username<input name="username" autoComplete="username" required maxLength={100} /></label>
        <label>Password<input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} required minLength={12} /></label>
        {setup && <label>Setup secret<input name="setupSecret" type="password" autoComplete="off" required /></label>}
        {error && <p className="message error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}</button>
      </form>
      {!setup && passwordResetEnabled && <section className="recovery-panel" aria-labelledby="recovery-title">
        <p className="eyebrow">RECOVERY MODE</p>
        <h2 id="recovery-title">Reset the existing account password</h2>
        <p>This one-use recovery mode was enabled in Compose. It keeps every audiobook and job.</p>
        <form onSubmit={resetPassword} className="form-stack">
          <label>Existing username<input name="username" autoComplete="username" required maxLength={100} /></label>
          <label>Setup secret<input name="setupSecret" type="password" autoComplete="off" required /></label>
          <label>New password<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} /></label>
          <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} /></label>
          {recoveryError && <p className="message error" role="alert">{recoveryError}</p>}
          {recoveryMessage && <p className="message success" role="status">{recoveryMessage}</p>}
          <button className="secondary" disabled={busy}>{busy ? 'Please wait…' : 'Reset password'}</button>
        </form>
      </section>}
    </section>
  </main>;
}
