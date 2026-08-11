import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { groupJobs } from './job-order.js';

type User = { username: string; role: string };
type Session = { csrf: string; user: User };
type Source = { id: string; filename: string; title: string; durationMs: number; duration: string };
type EmbeddedMetadata = { title: string; author: string; narrator: string; year: string; genre: string; description: string };
type Draft = { id: string; cover: boolean; suggestedTitle?: string; suggestedAuthor?: string; suggestedMetadata?: EmbeddedMetadata; sources: Source[] };
type JobPhase = 'queued' | 'reading_sources' | 'preparing_output' | 'encoding_audio' | 'validating_output' | 'completed';
type Job = { id: string; status: string; phase?: JobPhase; progress: number; queuePosition?: number; title: string; destination?: 'output' | 'download'; outputName?: string; downloadReady?: boolean; mediaReady?: boolean; retryable?: boolean; retryOf?: string; sourceDurationMs?: number; estimatedOutputBytes?: number; estimatedRemainingSeconds?: number; estimatedFinishAt?: string; estimateConfidence?: 'learning' | 'measured'; error?: { code: string; message: string; retryable?: boolean }; createdAt?: string; updatedAt?: string };
type InputChapter = { filename: string; title: string };
type PreflightIssue = { code: string; severity: 'warning' | 'error'; message: string };
type InputBook = { id: string; title: string; pathLabel: string; fileCount: number; sourceBytes: number; fingerprint: string; suggestedTitle: string; suggestedAuthor: string; issues: PreflightIssue[]; needsReview: boolean; alreadyConvertedJobId?: string; chapters: InputChapter[] };
type Metadata = { title: string; author: string; narrator: string; year: string; genre: string; description: string; bitrateKbps: 64 | 96 | 128; destination: 'output' | 'download' };
type BatchItem = { book: InputBook; metadata: Metadata; chapters: InputChapter[] };
type QueueSummary = { remainingJobs: number; queuedJobs: number; queuedSourceBytes: number; estimatedQueuedSeconds: number; estimatedRemainingSeconds: number; estimatedFinishAt?: string; currentJobId?: string; currentJobEstimatedRemainingSeconds?: number; currentJobEstimatedFinishAt?: string; confidence: 'learning' | 'measured'; forecastBasis: 'active_job_bytes' | 'history_bytes' | 'conservative_size'; forecastSampleCount: number };
type Theme = 'lavender' | 'mint' | 'sky' | 'amber' | 'rose' | 'graphite';
type Mode = 'system' | 'light' | 'dark';

const THEMES: Theme[] = ['lavender', 'mint', 'sky', 'amber', 'rose', 'graphite'];
const MODES: Mode[] = ['system', 'light', 'dark'];
const defaultMetadata = (): Metadata => ({ title: '', author: '', narrator: '', year: '', genre: 'Audiobook', description: '', bitrateKbps: 96, destination: 'output' });
const storedTheme = () => { const value = localStorage.getItem('vertiku-theme') as Theme | null; return value && THEMES.includes(value) ? value : 'lavender'; };
const storedMode = () => { const value = localStorage.getItem('vertiku-mode') as Mode | null; return value && MODES.includes(value) ? value : 'system'; };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  if (!response.ok) { const problem = await response.json().catch(() => ({ message: 'The request failed.' })) as { message?: string }; throw new Error(problem.message ?? 'The request failed.'); }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function uploadDraft(files: File[], cover: File | undefined, csrf: string, progress: (value: number) => void): Promise<Draft> {
  return new Promise((resolve, reject) => {
    const data = new FormData(); files.forEach((file) => data.append('files', file)); if (cover) data.append('cover', cover);
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/drafts'); xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.addEventListener('progress', (event) => event.lengthComputable && progress(Math.round((event.loaded / event.total) * 100)));
    xhr.addEventListener('load', () => { const body = JSON.parse(xhr.responseText || '{}') as Draft & { message?: string }; xhr.status >= 200 && xhr.status < 300 ? resolve(body) : reject(new Error(body.message ?? 'Upload failed.')); });
    xhr.addEventListener('error', () => reject(new Error('Upload failed.'))); xhr.send(data);
  });
}

function AuthScreen({ setup, passwordResetEnabled, onAuthenticated }: { setup: boolean; passwordResetEnabled: boolean; onAuthenticated: (session: Session) => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [recoveryMessage, setRecoveryMessage] = useState(''); const [recoveryError, setRecoveryError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const values = new FormData(event.currentTarget);
    try {
      if (setup) await requestJson('/api/setup', { method: 'POST', body: JSON.stringify({ username: values.get('username'), password: values.get('password'), setupSecret: values.get('setupSecret') }) });
      const session = await requestJson<Session>('/api/session', { method: 'POST', body: JSON.stringify({ username: values.get('username'), password: values.get('password') }) }); onAuthenticated(session);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Authentication failed.'); } finally { setBusy(false); }
  }
  async function resetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setRecoveryError(''); setRecoveryMessage(''); const form = event.currentTarget; const values = new FormData(form);
    try {
      if (values.get('newPassword') !== values.get('confirmPassword')) throw new Error('The new passwords do not match.');
      await requestJson('/api/password-reset', { method: 'POST', body: JSON.stringify({ username: values.get('username'), setupSecret: values.get('setupSecret'), newPassword: values.get('newPassword') }) });
      form.reset(); setRecoveryMessage('Password reset complete. Sign in above, then set VERTIKU_PASSWORD_RESET back to false and restart Vertiku.');
    } catch (reason) { setRecoveryError(reason instanceof Error ? reason.message : 'Password recovery failed.'); } finally { setBusy(false); }
  }
  return <main className="auth-layout"><section className="auth-card" aria-labelledby="auth-title">
    <img className="app-icon" src="/vertiku-icon.png" alt="" width="92" height="92" />
    <p className="eyebrow">VERTIKU</p><h1 id="auth-title">{setup ? 'Create your administrator account' : 'Welcome back'}</h1>
    <p>{setup ? 'Files stay on this server. Use the setup secret configured by the server owner.' : 'Sign in to create and manage your audiobooks.'}</p>
    <form onSubmit={submit} className="form-stack">
      <label>Username<input name="username" autoComplete="username" required maxLength={100} /></label>
      <label>Password<input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} required minLength={12} /></label>
      {setup && <label>Setup secret<input name="setupSecret" type="password" autoComplete="off" required /></label>}
      {error && <p className="message error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}</button>
    </form>
    {!setup && passwordResetEnabled && <section className="recovery-panel" aria-labelledby="recovery-title"><p className="eyebrow">RECOVERY MODE</p><h2 id="recovery-title">Reset the existing account password</h2><p>This one-use recovery mode was enabled in Compose. It keeps every audiobook and job.</p><form onSubmit={resetPassword} className="form-stack"><label>Existing username<input name="username" autoComplete="username" required maxLength={100} /></label><label>Setup secret<input name="setupSecret" type="password" autoComplete="off" required /></label><label>New password<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} /></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} /></label>{recoveryError && <p className="message error" role="alert">{recoveryError}</p>}{recoveryMessage && <p className="message success" role="status">{recoveryMessage}</p>}<button className="secondary" disabled={busy}>{busy ? 'Please wait…' : 'Reset password'}</button></form></section>}
  </section></main>;
}

function BatchReview({ items, setItems, busy, error, onBack, onQueue }: { items: BatchItem[]; setItems: (items: BatchItem[]) => void; busy: boolean; error: string; onBack: () => void; onQueue: () => void }) {
  const updateMetadata = (index: number, patch: Partial<Metadata>) => setItems(items.map((item, itemIndex) => itemIndex === index ? { ...item, metadata: { ...item.metadata, ...patch } } : item));
  const updateChapter = (itemIndex: number, chapterIndex: number, title: string) => setItems(items.map((item, index) => index === itemIndex ? { ...item, chapters: item.chapters.map((chapter, position) => position === chapterIndex ? { ...chapter, title } : chapter) } : item));
  const valid = items.every((item) => item.metadata.title.trim() && item.chapters.every((chapter) => chapter.title.trim()));
  return <section className="workspace-card psu-card batch-review" aria-labelledby="batch-review-title">
    <div className="section-heading"><div><p className="eyebrow">BATCH REVIEW</p><h1 id="batch-review-title">Review {items.length} audiobooks</h1><p>Output names come from the source folders. Embedded metadata and covers are applied during processing; missing metadata is never invented.</p></div><span className="step-pill">One at a time</span></div>
    <div className="batch-assurance" role="note"><span className="batch-path" aria-hidden="true"><i /><i /><i /></span><div><strong>Safe unattended queue</strong><p>All selected books are stored now, then analyzed, encoded, and validated sequentially. Source files stay in <code>/input</code>.</p></div></div>
    <ol className="batch-list">
      {items.map((item, index) => <li key={item.book.id} className="batch-book">
        <span className="chapter-number">{index + 1}</span>
        <div className="batch-book-fields">
          <label>Output filename<input value={item.metadata.title} required onChange={(event) => updateMetadata(index, { title: event.target.value.replace(/\.m4b$/i, '') })} /><small>.m4b</small></label>
          <small>{item.book.pathLabel} · {item.chapters.length} chapter{item.chapters.length === 1 ? '' : 's'} · {(item.book.sourceBytes / 1024 / 1024).toFixed(0)} MB source</small>
          {item.book.issues.length > 0 && <div className="preflight-issues" role="note">{item.book.issues.map((issue) => <p key={issue.code} className={issue.severity}><strong>{issue.severity === 'error' ? 'Needs attention' : 'Check'}:</strong> {issue.message}</p>)}</div>}
          <details><summary>Review quality, destination, and chapter titles</summary><div className="batch-details form-stack two-columns">
            <label>Quality<select value={item.metadata.bitrateKbps} onChange={(event) => updateMetadata(index, { bitrateKbps: Number(event.target.value) as 64 | 96 | 128 })}><option value="64">Compact · 64 kbps</option><option value="96">Recommended · 96 kbps</option><option value="128">High · 128 kbps</option></select></label>
            <fieldset className="destination-field full"><legend>Destination</legend><div className="destination-switch"><button type="button" aria-pressed={item.metadata.destination === 'output'} onClick={() => updateMetadata(index, { destination: 'output' })}><strong>Output folder</strong><small>Save to /output</small></button><button type="button" aria-pressed={item.metadata.destination === 'download'} onClick={() => updateMetadata(index, { destination: 'download' })}><strong>Browser download</strong><small>Keep in private /data</small></button></div></fieldset>
            <div className="batch-chapters full"><h3>Chapter titles</h3>{item.chapters.map((chapter, chapterIndex) => <label key={chapter.filename}><span>{chapterIndex + 1}. {chapter.filename}</span><input value={chapter.title} required onChange={(event) => updateChapter(index, chapterIndex, event.target.value)} /></label>)}</div>
          </div></details>
        </div>
      </li>)}
    </ol>
    {error && <p className="message error" role="alert">{error}</p>}
    <div className="sticky-actions"><button className="secondary" disabled={busy} onClick={onBack}>Back to selection</button><button className="primary" disabled={busy || !valid} onClick={onQueue}>{busy ? 'Adding the batch…' : `Queue all ${items.length} audiobooks`}</button></div>
  </section>;
}

function Converter({ session, onJob, onBatchQueued }: { session: Session; onJob: (job: Job) => void; onBatchQueued: (jobs: Job[]) => void }) {
  const fileId = useId(); const coverId = useId(); const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]); const [cover, setCover] = useState<File>(); const [draft, setDraft] = useState<Draft>();
  const [sourceMode, setSourceMode] = useState<'upload' | 'input'>(() => (localStorage.getItem('vertiku-last-source-mode') as 'upload' | 'input') || 'input');
  const [inputBooks, setInputBooks] = useState<InputBook[]>([]); const [selected, setSelected] = useState<Set<string>>(new Set()); const [batchItems, setBatchItems] = useState<BatchItem[]>();
  const [inputMounted, setInputMounted] = useState(false); const [inputLoading, setInputLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [metadata, setMetadata] = useState<Metadata>(defaultMetadata);
  const sortedNames = useMemo(() => [...files].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' })), [files]);
  async function loadInputBooks() { setInputLoading(true); setError(''); try { const result = await requestJson<{ mounted: boolean; books: InputBook[] }>('/api/input-books'); setInputMounted(result.mounted); setInputBooks(result.books); setSelected((current) => new Set([...current].filter((id) => result.books.some((book) => book.id === id && !book.issues.some((issue) => issue.severity === 'error'))))); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The input folder could not be read.'); } finally { setInputLoading(false); } }
  useEffect(() => { localStorage.setItem('vertiku-last-source-mode', sourceMode); if (sourceMode === 'input') void loadInputBooks(); }, [sourceMode]);
  function acceptFiles(list: FileList | File[]) { setFiles(Array.from(list).filter((file) => file.type.startsWith('audio/'))); setDraft(undefined); setError(''); }
  function openDraft(next: Draft, suggestedTitle: string, suggestedAuthor = '') { const embedded = next.suggestedMetadata; setDraft(next); setMetadata({ ...defaultMetadata(), title: embedded?.title || next.suggestedTitle || suggestedTitle, author: embedded?.author || next.suggestedAuthor || suggestedAuthor, narrator: embedded?.narrator || '', year: embedded?.year || '', genre: embedded?.genre || 'Audiobook', description: embedded?.description || '' }); }
  async function analyze() { setBusy(true); setError(''); try { const next = await uploadDraft(sortedNames, cover, session.csrf, setUploadProgress); openDraft(next, next.sources[0]?.title ?? 'My audiobook'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Analysis failed.'); } finally { setBusy(false); } }
  async function analyzeInput(book: InputBook) { setBusy(true); setError(''); try { const next = await requestJson<Draft>('/api/drafts/from-input', { method: 'POST', headers: { 'x-csrf-token': session.csrf }, body: JSON.stringify({ folderId: book.id }) }); openDraft(next, book.suggestedTitle, book.suggestedAuthor); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The input folder could not be analyzed.'); } finally { setBusy(false); } }
  function toggleBook(id: string) { setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function startBatchReview() { const books = inputBooks.filter((book) => selected.has(book.id)); setBatchItems(books.map((book) => ({ book, chapters: book.chapters.map((chapter) => ({ ...chapter })), metadata: { ...defaultMetadata(), title: book.title } }))); setError(''); }
  async function queueBatch() { if (!batchItems) return; setBusy(true); setError(''); try { const result = await requestJson<{ jobs: Job[] }>('/api/jobs/from-input/batch', { method: 'POST', headers: { 'x-csrf-token': session.csrf }, body: JSON.stringify({ items: batchItems.map((item) => ({ folderId: item.book.id, fingerprint: item.book.fingerprint, ...item.metadata, chapters: item.chapters })) }) }); onBatchQueued(result.jobs); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The batch could not be queued.'); } finally { setBusy(false); } }
  function move(index: number, delta: number) { if (!draft) return; const target = index + delta; if (target < 0 || target >= draft.sources.length) return; const sources = [...draft.sources]; const [item] = sources.splice(index, 1); if (item) sources.splice(target, 0, item); setDraft({ ...draft, sources }); }
  function rename(index: number, title: string) { if (!draft) return; setDraft({ ...draft, sources: draft.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, title } : source) }); }
  async function convert() { if (!draft) return; setBusy(true); setError(''); try { const job = await requestJson<Job>('/api/jobs', { method: 'POST', headers: { 'x-csrf-token': session.csrf }, body: JSON.stringify({ draftId: draft.id, ...metadata, bitrateKbps: Number(metadata.bitrateKbps), chapters: draft.sources.map((source) => ({ sourceId: source.id, title: source.title })) }) }); onJob(job); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Conversion could not be started.'); } finally { setBusy(false); } }

  if (batchItems) return <BatchReview items={batchItems} setItems={setBatchItems} busy={busy} error={error} onBack={() => setBatchItems(undefined)} onQueue={() => void queueBatch()} />;
  if (!draft) return <section className="source-layout" aria-labelledby="converter-title">
    <aside className="source-card psu-hero-card"><div><p className="eyebrow">NEW AUDIOBOOK</p><h1 id="converter-title">Create a chaptered M4B</h1><p>Each file becomes one chapter. Names are sorted naturally and repeated book names become distinct chapter numbers.</p></div>
      <div className="source-switch" role="group" aria-label="Audio source"><button aria-pressed={sourceMode === 'input'} onClick={() => setSourceMode('input')}>Input folder</button><button aria-pressed={sourceMode === 'upload'} onClick={() => setSourceMode('upload')}>Upload</button></div>
      {sourceMode === 'input' ? <div className="source-note"><strong>Read-only local source</strong><p>Select one book for detailed review, or select any number and queue the complete batch.</p></div> : <div className="compact-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); acceptFiles(event.dataTransfer.files); }}><span aria-hidden="true">＋</span><strong>Drop audio files</strong><small>MP3, M4A, AAC, WAV, FLAC, OGG, or Opus</small><button className="secondary" type="button" onClick={() => inputRef.current?.click()}>Choose files</button><input ref={inputRef} id={fileId} aria-label="Audio files" className="visually-hidden" type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus" multiple onChange={(event) => event.target.files && acceptFiles(event.target.files)} /></div>}
    </aside>
    <section className="workspace-card psu-card source-workspace">
      <div className="section-heading compact"><div><p className="eyebrow">SOURCE</p><h2>{sourceMode === 'input' ? 'Audiobooks in /input' : 'Selected files'}</h2><p>{sourceMode === 'input' ? 'Folders are read-only and symlinks are ignored.' : 'Review the naturally sorted file list before upload.'}</p></div>{sourceMode === 'input' && <button className="secondary" onClick={() => void loadInputBooks()} disabled={inputLoading}>Refresh</button>}</div>
      {sourceMode === 'input' ? inputLoading ? <div className="empty-state"><p>Scanning /input…</p></div> : !inputMounted ? <div className="empty-state"><img src="/vertiku-icon.png" alt="" /><h3>Input folder is not mounted</h3><p>Mount a host folder read-only at <code>/input</code>, then refresh.</p></div> : inputBooks.length === 0 ? <div className="empty-state"><img src="/vertiku-icon.png" alt="" /><h3>No audiobooks found</h3><p>Add one folder per audiobook. Audio files directly inside that folder become chapters.</p></div> : <>
        <div className="batch-toolbar"><div><strong>{selected.size} selected</strong><small>The persistent queue will process exactly one book at a time.</small></div><div className="button-row"><button className="text-button" onClick={() => setSelected(new Set(inputBooks.filter((book) => !book.needsReview).map((book) => book.id)))}>Select ready</button><button className="text-button" onClick={() => setSelected(new Set(inputBooks.filter((book) => !book.issues.some((issue) => issue.severity === 'error')).map((book) => book.id)))}>Select all valid</button><button className="text-button" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear</button><button className="primary" disabled={selected.size === 0 || busy} onClick={startBatchReview}>Batch review</button></div></div>
        <div className="input-book-list">{inputBooks.map((book) => { const blocked = book.issues.some((issue) => issue.severity === 'error'); return <article key={book.id} className={`input-book ${selected.has(book.id) ? 'selected' : ''} ${book.needsReview ? 'needs-review' : 'ready'}`}><label className="book-select"><input type="checkbox" checked={selected.has(book.id)} disabled={blocked} onChange={() => toggleBook(book.id)} /><span className="visually-hidden">Select {book.title}</span></label><span className="folder-symbol" aria-hidden="true">▰</span><div><strong>{book.title}</strong><small>{book.pathLabel} · {book.fileCount} chapter{book.fileCount === 1 ? '' : 's'} · {(book.sourceBytes / 1024 / 1024).toFixed(0)} MB</small><span className={`preflight-status ${blocked ? 'blocked' : book.needsReview ? 'review' : 'ready'}`}>{blocked ? 'Already queued' : book.needsReview ? `${book.issues.length} check${book.issues.length === 1 ? '' : 's'}` : 'Ready without review'}</span>{book.issues.map((issue) => <small key={issue.code}>{issue.message}</small>)}</div><button className="secondary" disabled={busy} onClick={() => void analyzeInput(book)}>Review</button></article>; })}</div>
      </> : sortedNames.length === 0 ? <div className="empty-state"><img src="/vertiku-icon.png" alt="" /><h3>No audio files selected</h3><p>Choose local files in the source card or drop them there.</p></div> : <div className="file-preview"><div className="list-heading"><h3>{sortedNames.length} file{sortedNames.length === 1 ? '' : 's'} ready</h3><button className="text-button" onClick={() => setFiles([])}>Clear</button></div><ol>{sortedNames.slice(0, 12).map((file) => <li key={`${file.name}-${file.size}`}><span>{file.name}</span><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></li>)}</ol>{sortedNames.length > 12 && <p>And {sortedNames.length - 12} more files</p>}<div className="cover-row"><label htmlFor={coverId}>Optional cover image</label><input id={coverId} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setCover(event.target.files?.[0])} />{cover && <span>{cover.name}</span>}</div>{busy && <div className="progress-wrap"><progress max="100" value={uploadProgress} aria-label="Upload progress" /><span>{uploadProgress}% uploaded</span></div>}<button className="primary wide" disabled={busy} onClick={() => void analyze()}>{busy ? 'Analyzing audio…' : 'Upload and review chapters'}</button></div>}
      {error && <p className="message error" role="alert">{error}</p>}
    </section>
  </section>;

  return <section className="editor-grid" aria-labelledby="review-title"><div className="workspace-card chapters-card"><div className="section-heading compact"><div><p className="eyebrow">AUDIOBOOK CONVERTER</p><h1 id="review-title">Review chapters</h1><p>Drag-free controls keep reordering accessible from the keyboard.</p></div><span className="step-pill">2 · Review</span></div>
    <ol className="chapter-list">{draft.sources.map((source, index) => <li key={source.id} className="chapter-item"><span className="chapter-number">{index + 1}</span><div><label><span className="visually-hidden">Chapter {index + 1} title</span><input value={source.title} onChange={(event) => rename(index, event.target.value)} /></label><small title={source.filename}>{source.filename} · {source.duration}</small></div><div className="order-buttons"><button aria-label={`Move chapter ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Move chapter ${index + 1} down`} disabled={index === draft.sources.length - 1} onClick={() => move(index, 1)}>↓</button></div></li>)}</ol>
  </div><aside className="workspace-card metadata-card"><div className="section-heading compact"><div><p className="eyebrow">BOOK DETAILS</p><h2>Metadata and quality</h2></div></div><div className="form-stack two-columns">
    <label className="full">Title<input value={metadata.title} required onChange={(event) => setMetadata({ ...metadata, title: event.target.value })} /></label>
    <label>Author<input value={metadata.author} onChange={(event) => setMetadata({ ...metadata, author: event.target.value })} /></label><label>Narrator<input value={metadata.narrator} onChange={(event) => setMetadata({ ...metadata, narrator: event.target.value })} /></label>
    <label>Year<input inputMode="numeric" pattern="[0-9]{4}" value={metadata.year} onChange={(event) => setMetadata({ ...metadata, year: event.target.value })} /></label><label>Genre<input value={metadata.genre} onChange={(event) => setMetadata({ ...metadata, genre: event.target.value })} /></label>
    <label className="full">Description<textarea rows={3} value={metadata.description} onChange={(event) => setMetadata({ ...metadata, description: event.target.value })} /></label>
    <label className="full">Audio quality<select value={metadata.bitrateKbps} onChange={(event) => setMetadata({ ...metadata, bitrateKbps: Number(event.target.value) as 64 | 96 | 128 })}><option value="64">Compact · 64 kbps</option><option value="96">Recommended · 96 kbps</option><option value="128">High · 128 kbps</option></select></label>
    <fieldset className="destination-field full"><legend>Destination</legend><div className="destination-switch"><button type="button" aria-pressed={metadata.destination === 'output'} onClick={() => setMetadata({ ...metadata, destination: 'output' })}><strong>Output folder</strong><small>Default · save to /output</small></button><button type="button" aria-pressed={metadata.destination === 'download'} onClick={() => setMetadata({ ...metadata, destination: 'download' })}><strong>Browser download</strong><small>Download when ready</small></button></div></fieldset>
  </div><div className="summary"><span>{draft.sources.length} chapters</span><span>{Math.round(draft.sources.reduce((sum, source) => sum + source.durationMs, 0) / 60000)} minutes</span><span>AAC in M4B</span></div>{error && <p className="message error" role="alert">{error}</p>}<button className="primary wide" disabled={busy || !metadata.title.trim() || draft.sources.some((source) => !source.title.trim())} onClick={() => void convert()}>{busy ? 'Adding to queue…' : 'Create audiobook'}</button></aside></section>;
}

function JobActivity({ job }: { job: Job }) {
  if (job.status === 'completed') return <div className="job-activity completed" aria-hidden="true">✓</div>;
  if (job.status === 'failed' || job.status === 'cancelled') return <div className="job-activity failed" aria-hidden="true">!</div>;
  return <div className={`job-activity ${job.status}`} aria-hidden="true"><span className="signal-bars"><i /><i /><i /><i /><i /></span><span className="signal-node" /></div>;
}

function phaseLabel(job: Job) {
  if (job.status === 'queued') return job.queuePosition ? `Queue position ${job.queuePosition}` : 'Queued';
  if (job.status === 'running') return job.phase === 'reading_sources' ? 'Reading source details' : job.phase === 'preparing_output' ? 'Preparing the M4B output' : job.phase === 'validating_output' ? 'Validating and publishing the M4B' : 'Encoding chapter audio';
  if (job.status === 'completed') return 'Completed';
  if (job.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

const JOB_STAGES: Array<{ phase: JobPhase; title: string; detail: string }> = [
  { phase: 'queued', title: 'Queued safely', detail: 'Store the job and source references before processing.' },
  { phase: 'reading_sources', title: 'Reading source details', detail: 'Read duration, embedded tags, chapters, and cover information.' },
  { phase: 'preparing_output', title: 'Preparing output', detail: 'Resolve metadata, filename, storage capacity, and the working file.' },
  { phase: 'encoding_audio', title: 'Encoding chapter audio', detail: 'Create the AAC audio stream and chapter timeline.' },
  { phase: 'validating_output', title: 'Validating and publishing', detail: 'Verify duration, chapter titles, and metadata before publishing.' }
];

function formatEstimate(seconds: number) {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.max(1, Math.round(seconds / 60)); const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  return hours ? `${hours} hr${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}` : `${minutes} min`;
}

function finishTime(value?: string) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'calculating'; }
function formatSourceSize(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`; }

function JobChecklist({ job }: { job: Job }) {
  const currentPhase = job.status === 'completed' ? 'completed' : job.phase ?? 'queued';
  const currentIndex = currentPhase === 'completed' ? JOB_STAGES.length : Math.max(0, JOB_STAGES.findIndex((stage) => stage.phase === currentPhase));
  return <section className="job-checklist" aria-labelledby="job-checklist-title"><div className="job-checklist-heading"><div><p className="eyebrow">PROCESS CHECKLIST</p><h2 id="job-checklist-title">Five steps to a validated audiobook</h2></div><span>{Math.min(currentIndex, JOB_STAGES.length)} of {JOB_STAGES.length} complete</span></div><ol>{JOB_STAGES.map((stage, index) => { const done = job.status === 'completed' || index < currentIndex; const current = job.status !== 'completed' && index === currentIndex; const stopped = current && (job.status === 'failed' || job.status === 'cancelled'); return <li key={stage.phase} className={done ? 'done' : stopped ? 'stopped' : current ? 'current' : 'pending'} aria-current={current ? 'step' : undefined}><span className="stage-marker" aria-hidden="true">{done ? '✓' : stopped ? '!' : index + 1}</span><div><strong>{stage.title}</strong><small>{stage.detail}</small>{current && <span className="stage-state">{stopped ? job.status === 'failed' ? 'Stopped here' : 'Cancelled here' : job.status === 'queued' ? 'Waiting to start' : 'In progress'}</span>}</div></li>; })}</ol></section>;
}

function QueueForecast({ queue }: { queue?: QueueSummary }) {
  if (!queue || queue.remainingJobs === 0) return null;
  const basis = queue.forecastBasis === 'active_job_bytes'
    ? "the active audiobook's measured processing rate"
    : queue.forecastBasis === 'history_bytes'
      ? `${queue.forecastSampleCount} persistent server measurement${queue.forecastSampleCount === 1 ? '' : 's'}`
      : 'a conservative source-size fallback while Vertiku learns this server';
  return <div className="queue-forecast" role="status"><p><strong>Full queue estimate</strong><span>{queue.remainingJobs} audiobook{queue.remainingJobs === 1 ? '' : 's'} remaining</span></p><p>About {formatEstimate(queue.estimatedRemainingSeconds)} · all queued work should finish around {finishTime(queue.estimatedFinishAt)}</p><small>Current audiobook plus about {formatEstimate(queue.estimatedQueuedSeconds)} for all {queue.queuedJobs} waiting book{queue.queuedJobs === 1 ? '' : 's'} ({formatSourceSize(queue.queuedSourceBytes)} source) · based on {basis}</small></div>;
}

function JobProgress({ job, session, onChange }: { job: Job; session: Session; onChange: (job: Job) => void }) {
  useEffect(() => { if (['completed', 'failed', 'cancelled'].includes(job.status)) return; const events = new EventSource(`/api/jobs/${job.id}/events`); events.addEventListener('job', (event) => onChange(JSON.parse((event as MessageEvent).data) as Job)); return () => events.close(); }, [job.id, job.status, onChange]);
  async function cancel() { const next = await requestJson<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST', headers: { 'x-csrf-token': session.csrf }, body: '{}' }); onChange({ ...job, ...next }); }
  async function retry() { const next = await requestJson<Job>(`/api/jobs/${job.id}/retry`, { method: 'POST', headers: { 'x-csrf-token': session.csrf }, body: '{}' }); onChange(next); }
  return <section className="workspace-card job-card"><div className="job-summary" aria-live="polite"><JobActivity job={job} /><p className="eyebrow">CONVERSION JOB</p><h1>{job.title || 'Your audiobook'}</h1><p className="job-phase">{phaseLabel(job)}</p><p className="job-status">{job.status === 'completed' ? job.destination === 'output' ? `Saved to /output/${job.outputName ?? 'audiobook.m4b'}.` : 'Your validated browser download is ready.' : job.status === 'failed' ? 'The conversion could not be completed. The remaining queue continued normally.' : job.status === 'cancelled' ? 'The conversion was cancelled.' : job.status === 'queued' ? 'Vertiku keeps your place safely and starts this book after every earlier book is complete.' : job.destination === 'output' ? 'Vertiku is working directly inside /output without creating a second result copy.' : 'Vertiku is preparing your private browser download.'}</p>{job.status === 'running' && job.estimatedRemainingSeconds !== undefined && <p className="job-eta"><strong>This audiobook:</strong> about {formatEstimate(job.estimatedRemainingSeconds)} remaining · expected around {finishTime(job.estimatedFinishAt)} <small>({job.estimateConfidence === 'measured' ? 'based on this server' : 'early estimate'})</small></p>}<progress max="100" value={job.progress} aria-label="Conversion progress" /><strong>{job.progress}%</strong></div><JobChecklist job={job} />{job.error && <p className="message error" role="alert"><strong>{job.error.code === 'ENGINE_FAILED' ? 'Conversion failed' : job.error.code === 'VALIDATION_FAILED' ? 'Validation failed' : job.error.code.replaceAll('_', ' ')}</strong><br />{job.error.message}</p>}{job.mediaReady && <div className="result-player"><h2>Listen to the validated result</h2><audio controls preload="metadata" src={`/api/jobs/${job.id}/media`}>Your browser cannot play this M4B file.</audio></div>}<div className="button-row centered">{!['completed', 'failed', 'cancelled'].includes(job.status) && <button className="secondary" onClick={() => void cancel()}>Cancel</button>}{job.retryable && <button className="secondary" onClick={() => void retry()}>Retry this audiobook</button>}{job.downloadReady && <a className="button primary" href={`/api/jobs/${job.id}/download`}>Download M4B</a>}</div></section>;
}

function App() {
  const [boot, setBoot] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading'); const [session, setSession] = useState<Session>();
  const [view, setView] = useState<'convert' | 'jobs' | 'about'>('convert'); const [activeJob, setActiveJob] = useState<Job>(); const [jobs, setJobs] = useState<Job[]>([]); const [queue, setQueue] = useState<QueueSummary>(); const [jobsNotice, setJobsNotice] = useState(''); const [menu, setMenu] = useState(false); const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  const [theme, setTheme] = useState<Theme>(storedTheme); const [mode, setMode] = useState<Mode>(storedMode);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.mode = mode;
      document.documentElement.dataset.resolvedMode = mode === 'system' ? media.matches ? 'dark' : 'light' : mode;
    };
    apply(); media.addEventListener('change', apply); localStorage.setItem('vertiku-theme', theme); localStorage.setItem('vertiku-mode', mode);
    return () => media.removeEventListener('change', apply);
  }, [theme, mode]);
  useEffect(() => { void (async () => { try { const next = await requestJson<Session>('/api/session'); setSession(next); setBoot('ready'); } catch { const status = await requestJson<{ required: boolean; passwordResetEnabled: boolean }>('/api/setup/status'); setPasswordResetEnabled(status.passwordResetEnabled); setBoot(status.required ? 'setup' : 'login'); } })(); }, []);
  useEffect(() => {
    if (!session || view !== 'jobs') return;
    let disposed = false;
    const apply = (result: { jobs: Job[]; queue: QueueSummary }) => { if (!disposed) { setJobs(result.jobs); setQueue(result.queue); } };
    const refresh = () => void requestJson<{ jobs: Job[]; queue: QueueSummary }>('/api/jobs').then(apply).catch(() => undefined);
    refresh(); const events = new EventSource('/api/jobs/events'); events.addEventListener('jobs', (event) => apply(JSON.parse((event as MessageEvent).data) as { jobs: Job[]; queue: QueueSummary }));
    const fallback = window.setInterval(refresh, 10_000);
    return () => { disposed = true; events.close(); window.clearInterval(fallback); };
  }, [session, view]);
  async function logout() { if (!session) return; await requestJson('/api/session', { method: 'DELETE', headers: { 'x-csrf-token': session.csrf } }); setSession(undefined); setBoot('login'); }
  if (boot === 'loading') return <main className="loading-screen"><img className="app-icon pulse" src="/vertiku-icon.png" alt="" /><p>Preparing Vertiku…</p></main>;
  if (boot === 'setup' || boot === 'login') return <AuthScreen setup={boot === 'setup'} passwordResetEnabled={passwordResetEnabled} onAuthenticated={(next) => { setSession(next); setBoot('ready'); }} />;
  if (!session) return null;
  const activeSession = session;
  const showJob = (job: Job) => { setActiveJob(job); setView('convert'); };
  const openConverter = () => { setActiveJob(undefined); setView('convert'); };
  const showBatch = (nextJobs: Job[]) => { setJobs(nextJobs); setActiveJob(undefined); setView('jobs'); };
  const retryableJobs = jobs.filter((job) => job.retryable).length;
  const stoppedJobs = jobs.filter((job) => ['failed', 'cancelled'].includes(job.status)).length;
  const jobGroups = groupJobs(jobs);
  async function retryFailed() { const result = await requestJson<{ jobs: Job[] }>('/api/jobs/retry-failed', { method: 'POST', headers: { 'x-csrf-token': activeSession.csrf }, body: '{}' }); if (result.jobs[0]) showJob(result.jobs[0]); }
  async function cancelWaiting() {
    const count = queue?.queuedJobs ?? 0;
    if (!count || !window.confirm(`Cancel all ${count} waiting audiobook${count === 1 ? '' : 's'}? The running conversion will continue.`)) return;
    await requestJson<{ cancelled: number }>('/api/jobs/cancel-queued', { method: 'POST', headers: { 'x-csrf-token': activeSession.csrf }, body: '{}' });
  }
  async function clearStopped() {
    if (!stoppedJobs || !window.confirm(`Clear ${stoppedJobs} failed or cancelled job${stoppedJobs === 1 ? '' : 's'} from this overview? Audiobooks and source files will not be deleted.`)) return;
    const result = await requestJson<{ cleared: number }>('/api/jobs/clear-stopped', { method: 'POST', headers: { 'x-csrf-token': activeSession.csrf }, body: '{}' });
    setJobs((current) => current.filter((job) => !['failed', 'cancelled'].includes(job.status)));
    setJobsNotice(`${result.cleared} job${result.cleared === 1 ? '' : 's'} cleared from the overview.`);
  }
  async function clearJob(job: Job) {
    if (!window.confirm(`Clear “${job.title}” from this overview? Its files will not be deleted.`)) return;
    await requestJson<{ cleared: number }>(`/api/jobs/${job.id}/clear`, { method: 'POST', headers: { 'x-csrf-token': activeSession.csrf }, body: '{}' });
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setJobsNotice(`“${job.title}” cleared from the overview.`);
  }
  return <div className="app-shell"><header className="topbar"><div className="topbar-inner"><button className="brand" onClick={openConverter}><span className="brand-symbol"><img src="/vertiku-icon.png" alt="" width="42" height="42" /></span><span><strong>Vertiku</strong><small>Everything in the right format.</small></span></button><span className="spacer" /><button className="profile-button" aria-expanded={menu} aria-haspopup="dialog" aria-label="Open profile and settings" onClick={() => setMenu(true)}>{session.user.username.slice(0, 2).toUpperCase()}</button></div></header>
    <main className="main-content">
      <nav className="desktop-nav" aria-label="Primary"><button aria-current={view === 'convert' ? 'page' : undefined} onClick={openConverter}>⇄ Convert</button><button aria-current={view === 'jobs' ? 'page' : undefined} onClick={() => setView('jobs')}>▷ Jobs</button><button aria-current={view === 'about' ? 'page' : undefined} onClick={() => setView('about')}>ⓘ About</button></nav>
      {view === 'convert' && (activeJob ? <JobProgress job={activeJob} session={session} onChange={setActiveJob} /> : <Converter session={session} onJob={showJob} onBatchQueued={showBatch} />)}
      {view === 'jobs' && <section className="workspace-card psu-card">
        <div className="section-heading"><div><p className="eyebrow">LIVE QUEUE</p><h1>Your conversion jobs</h1><p>Updates arrive automatically. Vertiku processes exactly one audiobook at a time.</p><QueueForecast queue={queue} /></div><div className="button-row">
          {retryableJobs > 0 && <button className="secondary" onClick={() => void retryFailed()}>Retry {retryableJobs} failed</button>}
          {stoppedJobs > 0 && <button className="secondary" onClick={() => void clearStopped()}>Clear failed &amp; cancelled ({stoppedJobs})</button>}
          {Boolean(queue?.queuedJobs) && <button className="secondary" onClick={() => void cancelWaiting()}>Cancel all waiting ({queue!.queuedJobs})</button>}
          <button className="primary" onClick={openConverter}>New audiobook</button>
        </div></div>
        {jobsNotice && <p className="message success" role="status">{jobsNotice}</p>}
        {jobs.length === 0 ? <div className="empty-state"><img src="/vertiku-icon.png" alt="" /><h2>No jobs yet</h2><p>Your audiobook conversions will appear here.</p></div> : <div className="job-groups">{jobGroups.map((group) => <section className="job-group" key={group.id} aria-labelledby={`job-group-${group.id}`}><div className="job-group-heading"><h2 id={`job-group-${group.id}`}>{group.title}</h2><span>{group.jobs.length}</span></div><div className="jobs-list">{group.jobs.map((job) => <div className="job-list-item" key={job.id}>
          <button className="job-list-open" onClick={() => showJob(job)}><span><strong>{job.title}</strong><small>{job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}{job.retryOf ? ' · Retry' : ''}{job.status === 'queued' && job.queuePosition ? ` · Position ${job.queuePosition}` : ''}</small></span><span className="job-list-state"><span className={`status-label ${job.status}`}>{phaseLabel(job)}</span><small>{job.progress}%</small></span></button>
          {['completed', 'failed', 'cancelled'].includes(job.status) && <button className="job-list-clear" aria-label={`Clear ${job.title} from job history`} onClick={() => void clearJob(job)}>Clear entry</button>}
        </div>)}</div></section>)}</div>}
      </section>}
      {view === 'about' && <section className="workspace-card psu-card about-card"><img className="app-icon" src="/vertiku-icon.png" alt="" /><p className="eyebrow">ABOUT</p><h1>Vertiku</h1><p>A private, self-hosted conversion workspace. Vertiku creates chaptered M4B audiobooks from uploads or read-only folders below <code>/input</code>.</p><dl><div><dt>Version</dt><dd>0.5.2</dd></div><div><dt>Conversion engine</dt><dd>FFmpeg (runtime detected)</dd></div><div><dt>Privacy</dt><dd>No remote URL imports or outbound media services</dd></div></dl><p className="fine-print">Vertiku does not bypass DRM, includes no yt-dlp integration, and has no dependency on Pulliku.</p></section>}
    </main>
    <nav className="mobile-nav" aria-label="Primary"><button aria-current={view === 'convert' ? 'page' : undefined} onClick={openConverter}><span aria-hidden="true">⇄</span>Convert</button><button aria-current={view === 'jobs' ? 'page' : undefined} onClick={() => setView('jobs')}><span aria-hidden="true">▷</span>Jobs</button><button aria-current={view === 'about' ? 'page' : undefined} onClick={() => setView('about')}><span aria-hidden="true">ⓘ</span>About</button></nav>
    {menu && <div className="profile-backdrop" onMouseDown={() => setMenu(false)}><aside className="profile-menu" role="dialog" aria-modal="true" aria-labelledby="profile-title" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-head"><button className="icon-button" aria-label="Close profile and settings" onClick={() => setMenu(false)}>×</button><h2 id="profile-title">Vertiku</h2><span /></div><div className="account-card"><span>{session.user.username.slice(0, 2).toUpperCase()}</span><div><strong>{session.user.username}</strong><small>{session.user.role} account</small></div></div><section className="settings-section"><h3>Appearance</h3><div className="theme-grid">{THEMES.map((item) => <button key={item} className="theme-choice" aria-pressed={theme === item} onClick={() => setTheme(item)}>{item[0]?.toUpperCase()}{item.slice(1)}</button>)}</div><div className="mode-switch" role="group" aria-label="Appearance mode">{MODES.map((item) => <button key={item} aria-pressed={mode === item} onClick={() => setMode(item)}>{item[0]?.toUpperCase()}{item.slice(1)}</button>)}</div></section><button className="signout-button" onClick={() => void logout()}>Sign out</button></aside></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
