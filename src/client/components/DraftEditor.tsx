import type { Draft, Metadata } from '../types.js';
import { DestinationSwitch, QualitySelect } from './fields.js';

type DraftEditorProps = {
  draft: Draft; setDraft: (draft: Draft) => void;
  metadata: Metadata; setMetadata: (metadata: Metadata) => void;
  busy: boolean; error: string; onConvert: () => void;
};

export function DraftEditor({ draft, setDraft, metadata, setMetadata, busy, error, onConvert }: DraftEditorProps) {
  const update = (patch: Partial<Metadata>) => setMetadata({ ...metadata, ...patch });
  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= draft.sources.length) return;
    const sources = [...draft.sources]; const [item] = sources.splice(index, 1);
    if (item) sources.splice(target, 0, item);
    setDraft({ ...draft, sources });
  }
  const rename = (index: number, title: string) => setDraft({ ...draft, sources: draft.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, title } : source) });
  const totalMinutes = Math.round(draft.sources.reduce((sum, source) => sum + source.durationMs, 0) / 60000);
  const ready = metadata.title.trim() && draft.sources.every((source) => source.title.trim());

  return <section className="editor-grid" aria-labelledby="review-title">
    <div className="workspace-card chapters-card">
      <div className="section-heading compact">
        <div><p className="eyebrow">AUDIOBOOK CONVERTER</p><h1 id="review-title">Review chapters</h1><p>Drag-free controls keep reordering accessible from the keyboard.</p></div>
        <span className="step-pill">2 · Review</span>
      </div>
      <ol className="chapter-list">
        {draft.sources.map((source, index) => <li key={source.id} className="chapter-item">
          <span className="chapter-number">{index + 1}</span>
          <div>
            <label><span className="visually-hidden">Chapter {index + 1} title</span><input value={source.title} onChange={(event) => rename(index, event.target.value)} /></label>
            <small title={source.filename}>{source.filename} · {source.duration}</small>
          </div>
          <div className="order-buttons">
            <button aria-label={`Move chapter ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button aria-label={`Move chapter ${index + 1} down`} disabled={index === draft.sources.length - 1} onClick={() => move(index, 1)}>↓</button>
          </div>
        </li>)}
      </ol>
    </div>
    <aside className="workspace-card metadata-card">
      <div className="section-heading compact"><div><p className="eyebrow">BOOK DETAILS</p><h2>Metadata and quality</h2></div></div>
      <div className="form-stack two-columns">
        <label className="full">Title<input value={metadata.title} required onChange={(event) => update({ title: event.target.value })} /></label>
        <label>Author<input value={metadata.author} onChange={(event) => update({ author: event.target.value })} /></label>
        <label>Narrator<input value={metadata.narrator} onChange={(event) => update({ narrator: event.target.value })} /></label>
        <label>Year<input inputMode="numeric" pattern="[0-9]{4}" value={metadata.year} onChange={(event) => update({ year: event.target.value })} /></label>
        <label>Genre<input value={metadata.genre} onChange={(event) => update({ genre: event.target.value })} /></label>
        <label className="full">Description<textarea rows={3} value={metadata.description} onChange={(event) => update({ description: event.target.value })} /></label>
        <QualitySelect label="Audio quality" className="full" value={metadata.bitrateKbps} onChange={(bitrateKbps) => update({ bitrateKbps })} />
        <DestinationSwitch value={metadata.destination} onChange={(destination) => update({ destination })} hints={{ output: 'Default · save to /output', download: 'Download when ready' }} />
      </div>
      <div className="summary"><span>{draft.sources.length} chapters</span><span>{totalMinutes} minutes</span><span>AAC in M4B</span></div>
      {error && <p className="message error" role="alert">{error}</p>}
      <button className="primary wide" disabled={busy || !ready} onClick={onConvert}>{busy ? 'Adding to queue…' : 'Create audiobook'}</button>
    </aside>
  </section>;
}
