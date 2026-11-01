import { formatSourceSize, plural } from '../format.js';
import type { BatchItem, Metadata } from '../types.js';
import { DestinationSwitch, QualitySelect } from './fields.js';

type BatchReviewProps = { items: BatchItem[]; setItems: (items: BatchItem[]) => void; busy: boolean; error: string; onBack: () => void; onQueue: () => void };

export function BatchReview({ items, setItems, busy, error, onBack, onQueue }: BatchReviewProps) {
  const updateMetadata = (index: number, patch: Partial<Metadata>) =>
    setItems(items.map((item, itemIndex) => itemIndex === index ? { ...item, metadata: { ...item.metadata, ...patch } } : item));
  const updateChapter = (itemIndex: number, chapterIndex: number, title: string) =>
    setItems(items.map((item, index) => index === itemIndex ? { ...item, chapters: item.chapters.map((chapter, position) => position === chapterIndex ? { ...chapter, title } : chapter) } : item));
  const valid = items.every((item) => item.metadata.title.trim() && item.chapters.every((chapter) => chapter.title.trim()));

  return <section className="workspace-card psu-card batch-review" aria-labelledby="batch-review-title">
    <div className="section-heading">
      <div>
        <p className="eyebrow">BATCH REVIEW</p>
        <h1 id="batch-review-title">Review {items.length} audiobooks</h1>
        <p>Output names come from the source folders. Embedded metadata and covers are applied during processing; missing metadata is never invented.</p>
      </div>
      <span className="step-pill">One at a time</span>
    </div>
    <div className="batch-assurance" role="note">
      <span className="batch-path" aria-hidden="true"><i /><i /><i /></span>
      <div><strong>Safe unattended queue</strong><p>All selected books are stored now, then analyzed, encoded, and validated sequentially. Source files stay in <code>/input</code>.</p></div>
    </div>
    <ol className="batch-list">
      {items.map((item, index) => <li key={item.book.id} className="batch-book">
        <span className="chapter-number">{index + 1}</span>
        <div className="batch-book-fields">
          <label>Output filename<input value={item.metadata.title} required onChange={(event) => updateMetadata(index, { title: event.target.value.replace(/\.m4b$/i, '') })} /><small>.m4b</small></label>
          <small>{item.book.pathLabel} · {plural(item.chapters.length, 'chapter')} · {formatSourceSize(item.book.sourceBytes)} source</small>
          {item.book.issues.length > 0 && <div className="preflight-issues" role="note">
            {item.book.issues.map((issue) => <p key={issue.code} className={issue.severity}><strong>{issue.severity === 'error' ? 'Needs attention' : 'Check'}:</strong> {issue.message}</p>)}
          </div>}
          <details>
            <summary>Review quality, destination, and chapter titles</summary>
            <div className="batch-details form-stack two-columns">
              <QualitySelect label="Quality" value={item.metadata.bitrateKbps} onChange={(bitrateKbps) => updateMetadata(index, { bitrateKbps })} />
              <DestinationSwitch value={item.metadata.destination} onChange={(destination) => updateMetadata(index, { destination })} hints={{ output: 'Save to /output', download: 'Keep in private /data' }} />
              <div className="batch-chapters full">
                <h3>Chapter titles</h3>
                {item.chapters.map((chapter, chapterIndex) => <label key={chapter.filename}>
                  <span>{chapterIndex + 1}. {chapter.filename}</span>
                  <input value={chapter.title} required onChange={(event) => updateChapter(index, chapterIndex, event.target.value)} />
                </label>)}
              </div>
            </div>
          </details>
        </div>
      </li>)}
    </ol>
    {error && <p className="message error" role="alert">{error}</p>}
    <div className="sticky-actions">
      <button className="secondary" disabled={busy} onClick={onBack}>Back to selection</button>
      <button className="primary" disabled={busy || !valid} onClick={onQueue}>{busy ? 'Adding the batch…' : `Queue all ${items.length} audiobooks`}</button>
    </div>
  </section>;
}
