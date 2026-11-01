import { formatSourceSize, plural } from '../format.js';
import type { InputBook } from '../types.js';
import { EmptyState } from './fields.js';

const isBlocked = (book: InputBook) => book.issues.some((issue) => issue.severity === 'error');

type InputLibraryProps = {
  books: InputBook[]; mounted: boolean; loading: boolean; busy: boolean;
  selected: Set<string>; setSelected: (selected: Set<string>) => void;
  onReview: (book: InputBook) => void; onBatchReview: () => void;
};

export function InputLibrary({ books, mounted, loading, busy, selected, setSelected, onReview, onBatchReview }: InputLibraryProps) {
  if (loading) return <div className="empty-state"><p>Scanning /input…</p></div>;
  if (!mounted) return <EmptyState title="Input folder is not mounted">Mount a host folder read-only at <code>/input</code>, then refresh.</EmptyState>;
  if (books.length === 0) return <EmptyState title="No audiobooks found">Add one folder per audiobook. Audio files directly inside that folder become chapters.</EmptyState>;

  const toggle = (id: string) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); };
  return <>
    <div className="batch-toolbar">
      <div><strong>{selected.size} selected</strong><small>The persistent queue will process exactly one book at a time.</small></div>
      <div className="button-row">
        <button className="text-button" onClick={() => setSelected(new Set(books.filter((book) => !book.needsReview).map((book) => book.id)))}>Select ready</button>
        <button className="text-button" onClick={() => setSelected(new Set(books.filter((book) => !isBlocked(book)).map((book) => book.id)))}>Select all valid</button>
        <button className="text-button" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear</button>
        <button className="primary" disabled={selected.size === 0 || busy} onClick={onBatchReview}>Batch review</button>
      </div>
    </div>
    <div className="input-book-list">
      {books.map((book) => {
        const blocked = isBlocked(book);
        const status = blocked ? 'blocked' : book.needsReview ? 'review' : 'ready';
        return <article key={book.id} className={`input-book ${selected.has(book.id) ? 'selected' : ''} ${book.needsReview ? 'needs-review' : 'ready'}`}>
          <label className="book-select">
            <input type="checkbox" checked={selected.has(book.id)} disabled={blocked} onChange={() => toggle(book.id)} />
            <span className="visually-hidden">Select {book.title}</span>
          </label>
          <span className="folder-symbol" aria-hidden="true">▰</span>
          <div>
            <strong>{book.title}</strong>
            <small>{book.pathLabel} · {plural(book.fileCount, 'chapter')} · {formatSourceSize(book.sourceBytes)}</small>
            <span className={`preflight-status ${status}`}>{blocked ? 'Already queued' : book.needsReview ? plural(book.issues.length, 'check') : 'Ready without review'}</span>
            {book.issues.map((issue) => <small key={issue.code}>{issue.message}</small>)}
          </div>
          <button className="secondary" disabled={busy} onClick={() => onReview(book)}>Review</button>
        </article>;
      })}
    </div>
  </>;
}
