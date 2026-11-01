import { useId } from 'react';
import { plural } from '../format.js';
import { EmptyState } from './fields.js';

const PREVIEW_LIMIT = 12;

type UploadListProps = {
  files: File[]; cover?: File; setCover: (cover: File | undefined) => void;
  busy: boolean; uploadProgress: number; onClear: () => void; onAnalyze: () => void;
};

export function UploadList({ files, cover, setCover, busy, uploadProgress, onClear, onAnalyze }: UploadListProps) {
  const coverId = useId();
  if (files.length === 0) return <EmptyState title="No audio files selected">Choose local files in the source card or drop them there.</EmptyState>;
  const uploading = uploadProgress < 100;
  return <div className="file-preview">
    <div className="list-heading"><h3>{plural(files.length, 'file')} ready</h3><button className="text-button" onClick={onClear}>Clear</button></div>
    <ol>{files.slice(0, PREVIEW_LIMIT).map((file) => <li key={`${file.name}-${file.size}`}><span>{file.name}</span><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></li>)}</ol>
    {files.length > PREVIEW_LIMIT && <p>And {files.length - PREVIEW_LIMIT} more files</p>}
    <div className="cover-row">
      <label htmlFor={coverId}>Optional cover image</label>
      <input id={coverId} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setCover(event.target.files?.[0])} />
      {cover && <span>{cover.name}</span>}
    </div>
    {busy && <div className="progress-wrap" aria-live="polite">
      <progress max="100" value={uploadProgress} aria-label="Upload progress" />
      <span>{uploading ? `${uploadProgress}% uploaded` : 'Upload complete · analyzing audio on the server…'}</span>
    </div>}
    <button className="primary wide" disabled={busy} onClick={onAnalyze}>{busy ? uploading ? 'Uploading…' : 'Analyzing audio…' : 'Upload and review chapters'}</button>
  </div>;
}
