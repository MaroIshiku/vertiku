import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { requestJson, setSessionExpiredHandler } from './api.js';
import { useAppearance } from './appearance.js';
import { AboutView } from './components/AboutView.js';
import { AuthScreen } from './components/AuthScreen.js';
import { Converter } from './components/Converter.js';
import { JobProgress } from './components/JobProgress.js';
import { JobsView } from './components/JobsView.js';
import { ProfileMenu } from './components/ProfileMenu.js';
import type { Job, Session } from './types.js';

type Boot = 'loading' | 'setup' | 'login' | 'ready' | 'error';
type View = 'convert' | 'jobs' | 'about';

const NAVIGATION: Array<{ view: View; label: string; symbol: string }> = [
  { view: 'convert', label: 'Convert', symbol: '⇄' },
  { view: 'jobs', label: 'Jobs', symbol: '▷' },
  { view: 'about', label: 'About', symbol: 'ⓘ' }
];

function App() {
  const [boot, setBoot] = useState<Boot>('loading');
  const [session, setSession] = useState<Session>();
  const [authNotice, setAuthNotice] = useState('');
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  const [version, setVersion] = useState('');
  const [view, setView] = useState<View>('convert');
  const [activeJob, setActiveJob] = useState<Job>();
  const [batchJobs, setBatchJobs] = useState<Job[]>();
  const [menu, setMenu] = useState(false);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const appearance = useAppearance();
  const closeMenu = useCallback(() => setMenu(false), []);

  async function bootstrap() {
    setBoot('loading');
    try { setSession(await requestJson<Session>('/api/session')); setBoot('ready'); return; } catch { /* No active session; continue with setup or sign-in. */ }
    try {
      const status = await requestJson<{ required: boolean; passwordResetEnabled: boolean }>('/api/setup/status');
      setPasswordResetEnabled(status.passwordResetEnabled);
      setBoot(status.required ? 'setup' : 'login');
    } catch { setBoot('error'); }
  }

  useEffect(() => {
    void bootstrap();
    void requestJson<{ version: string }>('/api/manifest').then((manifest) => setVersion(manifest.version)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!session) return;
    setSessionExpiredHandler(() => { setSession(undefined); setMenu(false); setAuthNotice('Your session has ended. Sign in again to continue.'); setBoot('login'); });
    return () => setSessionExpiredHandler(undefined);
  }, [session]);

  async function signOut() {
    if (session) await requestJson('/api/session', { method: 'DELETE', headers: { 'x-csrf-token': session.csrf } }).catch(() => undefined);
    setSession(undefined); setMenu(false); setAuthNotice(''); setBoot('login');
  }

  if (boot === 'loading') return <main className="loading-screen"><img className="app-icon pulse" src="/vertiku-icon.png" alt="" /><p>Preparing Vertiku…</p></main>;
  if (boot === 'error') return <main className="loading-screen">
    <img className="app-icon" src="/vertiku-icon.png" alt="" />
    <p role="alert">Vertiku could not be reached. Check that the server is running, then try again.</p>
    <button className="primary" onClick={() => void bootstrap()}>Try again</button>
  </main>;
  if (boot === 'setup' || boot === 'login') return <AuthScreen setup={boot === 'setup'} passwordResetEnabled={passwordResetEnabled} notice={authNotice} onAuthenticated={(next) => { setSession(next); setAuthNotice(''); setBoot('ready'); }} />;
  if (!session) return null;

  const showJob = (job: Job) => { setActiveJob(job); setView('convert'); };
  const navigate = (next: View) => { if (next === 'convert') setActiveJob(undefined); if (next === 'jobs') setBatchJobs(undefined); setView(next); };
  const showBatch = (jobs: Job[]) => { setBatchJobs(jobs); setActiveJob(undefined); setView('jobs'); };
  const navButtons = (mobile: boolean) => NAVIGATION.map((item) => <button key={item.view} aria-current={view === item.view ? 'page' : undefined} onClick={() => navigate(item.view)}>
    {mobile ? <><span aria-hidden="true">{item.symbol}</span>{item.label}</> : `${item.symbol} ${item.label}`}
  </button>);

  return <div className="app-shell">
    <header className="topbar">
      <div className="topbar-inner">
        <button className="brand" onClick={() => navigate('convert')}>
          <span className="brand-symbol"><img src="/vertiku-icon.png" alt="" width="42" height="42" /></span>
          <span><strong>Vertiku</strong><small>Everything in the right format.</small></span>
        </button>
        <span className="spacer" />
        <button ref={profileButtonRef} className="profile-button" aria-expanded={menu} aria-haspopup="dialog" aria-label="Open profile and settings" onClick={() => setMenu(true)}>{session.user.username.slice(0, 2).toUpperCase()}</button>
      </div>
    </header>
    <main className="main-content">
      <nav className="desktop-nav" aria-label="Primary">{navButtons(false)}</nav>
      {view === 'convert' && (activeJob
        ? <JobProgress job={activeJob} session={session} onChange={setActiveJob} onShowJobs={() => navigate('jobs')} />
        : <Converter session={session} onJob={showJob} onBatchQueued={showBatch} />)}
      {view === 'jobs' && <JobsView session={session} initialJobs={batchJobs} onOpenJob={showJob} onNewAudiobook={() => navigate('convert')} />}
      {view === 'about' && <AboutView version={version} />}
    </main>
    <nav className="mobile-nav" aria-label="Primary">{navButtons(true)}</nav>
    {menu && <ProfileMenu session={session} {...appearance} returnFocusRef={profileButtonRef} onClose={closeMenu} onSignOut={() => void signOut()} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
