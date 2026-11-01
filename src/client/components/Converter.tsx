import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage, postJson, requestJson, uploadDraft } from '../api.js';
import { isSupportedAudio, naturalCompare } from '../format.js';
import { defaultMetadata, type BatchItem, type Draft, type InputBook, type Job, type Metadata, type Session } from '../types.js';
import { BatchReview } from './BatchReview.js';
import { DraftEditor } from './DraftEditor.js';
import { InputLibrary } from './InputLibrary.js';
import { UploadList } from './UploadList.js';

type SourceMode = 'upload' | 'input';
const SOURCE_MODE_KEY = 'vertiku-last-source-mode';

type ConverterProps = { session: Session; onJob: (job: Job) => void; onBatchQueued: (jobs: Job[]) => void };

export function Converter({ session, onJob, onBatchQueued }: ConverterProps) {
  const fileId = useId(); const inputRef = useRef<HTMLInputElement>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>(() => (localStorage.getItem(SOURCE_MODE_KEY) as SourceMode | null) || 'input');
  const [files, setFiles] = useState<File[]>([]); const [cover, setCover] = useState<File>(); const [fileNotice, setFileNotice] = useState('');
  const [inputBooks, setInputBooks] = useState<InputBook[]>([]); const [inputMounted, setInputMounted] = useState(false); const [inputLoading, setInputLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [batchItems, setBatchItems] = useState<BatchItem[]>();
  const [draft, setDraft] = useState<Draft>(); const [metadata, setMetadata] = useState<Metadata>(defaultMetadata);
  const [uploadProgress, setUploadProgress] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sortedFiles = useMemo(() => [...files].sort((left, right) => naturalCompare(left.name, right.name)), [files]);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { setError(errorMessage(reason, fallback)); } finally { setBusy(false); }
  }

  async function loadInputBooks() {
    setInputLoading(true); setError('');
    try {
      const result = await requestJson<{ mounted: boolean; books: InputBook[] }>('/api/input-books');
      setInputMounted(result.mounted); setInputBooks(result.books);
      // Keep only selections that still exist and are not blocked.
      setSelected((current) => new Set([...current].filter((id) => result.books.some((book) => book.id === id && !book.issues.some((issue) => issue.severity === 'error')))));
    } catch (reason) { setError(errorMessage(reason, 'The input folder could not be read.')); } finally { setInputLoading(false); }
  }
  useEffect(() => { localStorage.setItem(SOURCE_MODE_KEY, sourceMode); if (sourceMode === 'input') void loadInputBooks(); }, [sourceMode]);

  function acceptFiles(list: FileList | File[]) {
    const all = Array.from(list); const supported = all.filter(isSupportedAudio); const skipped = all.length - supported.length;
    setFiles(supported); setDraft(undefined); setError('');
    setFileNotice(skipped ? `${skipped} unsupported file${skipped === 1 ? ' was' : 's were'} skipped. Supported formats: MP3, M4A, AAC, WAV, FLAC, OGG, and Opus.` : '');
  }

  /** Embedded tags win over folder-derived suggestions; missing fields stay empty. */
  function openDraft(next: Draft, suggestedTitle: string, suggestedAuthor = '') {
    const embedded = next.suggestedMetadata;
    setDraft(next);
    setMetadata({ ...defaultMetadata(), title: embedded?.title || next.suggestedTitle || suggestedTitle, author: embedded?.author || next.suggestedAuthor || suggestedAuthor, narrator: embedded?.narrator || '', year: embedded?.year || '', genre: embedded?.genre || 'Audiobook', description: embedded?.description || '' });
  }

  const analyzeUpload = () => run(async () => {
    setUploadProgress(0);
    const next = await uploadDraft(sortedFiles, cover, session.csrf, setUploadProgress);
    openDraft(next, next.sources[0]?.title ?? 'My audiobook');
  }, 'Analysis failed.');

  const analyzeInput = (book: InputBook) => run(async () => {
    openDraft(await postJson<Draft>('/api/drafts/from-input', session.csrf, { folderId: book.id }), book.suggestedTitle, book.suggestedAuthor);
  }, 'The input folder could not be analyzed.');

  function startBatchReview() {
    setBatchItems(inputBooks.filter((book) => selected.has(book.id)).map((book) => ({ book, chapters: book.chapters.map((chapter) => ({ ...chapter })), metadata: { ...defaultMetadata(), title: book.title } })));
    setError('');
  }

  const queueBatch = () => run(async () => {
    if (!batchItems) return;
    const result = await postJson<{ jobs: Job[] }>('/api/jobs/from-input/batch', session.csrf, { items: batchItems.map((item) => ({ folderId: item.book.id, fingerprint: item.book.fingerprint, ...item.metadata, chapters: item.chapters })) });
    onBatchQueued(result.jobs);
  }, 'The batch could not be queued.');

  const convert = () => run(async () => {
    if (!draft) return;
    onJob(await postJson<Job>('/api/jobs', session.csrf, { draftId: draft.id, ...metadata, bitrateKbps: Number(metadata.bitrateKbps), chapters: draft.sources.map((source) => ({ sourceId: source.id, title: source.title })) }));
  }, 'Conversion could not be started.');

  if (batchItems) return <BatchReview items={batchItems} setItems={setBatchItems} busy={busy} error={error} onBack={() => setBatchItems(undefined)} onQueue={() => void queueBatch()} />;
  if (draft) return <DraftEditor draft={draft} setDraft={setDraft} metadata={metadata} setMetadata={setMetadata} busy={busy} error={error} onConvert={() => void convert()} />;

  const inputMode = sourceMode === 'input';
  return <section className="source-layout" aria-labelledby="converter-title">
    <aside className="source-card psu-hero-card">
      <div>
        <p className="eyebrow">NEW AUDIOBOOK</p>
        <h1 id="converter-title">Create a chaptered M4B</h1>
        <p>Each file becomes one chapter. Names are sorted naturally and repeated book names become distinct chapter numbers.</p>
      </div>
      <div className="source-switch" role="group" aria-label="Audio source">
        <button aria-pressed={inputMode} onClick={() => setSourceMode('input')}>Input folder</button>
        <button aria-pressed={!inputMode} onClick={() => setSourceMode('upload')}>Upload</button>
      </div>
      {inputMode
        ? <div className="source-note"><strong>Read-only local source</strong><p>Select one book for detailed review, or select any number and queue the complete batch.</p></div>
        : <div className="compact-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); acceptFiles(event.dataTransfer.files); }}>
          <span aria-hidden="true">＋</span>
          <strong>Drop audio files</strong>
          <small>MP3, M4A, AAC, WAV, FLAC, OGG, or Opus</small>
          <button className="secondary" type="button" onClick={() => inputRef.current?.click()}>Choose files</button>
          <input ref={inputRef} id={fileId} aria-label="Audio files" className="visually-hidden" type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus" multiple onChange={(event) => event.target.files && acceptFiles(event.target.files)} />
        </div>}
    </aside>
    <section className="workspace-card psu-card source-workspace">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">SOURCE</p>
          <h2>{inputMode ? 'Audiobooks in /input' : 'Selected files'}</h2>
          <p>{inputMode ? 'Folders are read-only and symlinks are ignored.' : 'Review the naturally sorted file list before upload.'}</p>
        </div>
        {inputMode && <button className="secondary" onClick={() => void loadInputBooks()} disabled={inputLoading}>Refresh</button>}
      </div>
      {inputMode
        ? <InputLibrary books={inputBooks} mounted={inputMounted} loading={inputLoading} busy={busy} selected={selected} setSelected={setSelected} onReview={(book) => void analyzeInput(book)} onBatchReview={startBatchReview} />
        : <UploadList files={sortedFiles} cover={cover} setCover={setCover} busy={busy} uploadProgress={uploadProgress} onClear={() => { setFiles([]); setFileNotice(''); }} onAnalyze={() => void analyzeUpload()} />}
      {!inputMode && fileNotice && <p className="message info" role="status">{fileNotice}</p>}
      {error && <p className="message error" role="alert">{error}</p>}
    </section>
  </section>;
}
