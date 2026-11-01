import type { ReactNode } from 'react';
import type { Bitrate, Destination } from '../types.js';

export function QualitySelect({ label, value, onChange, className }: { label: string; value: Bitrate; onChange: (value: Bitrate) => void; className?: string }) {
  return <label className={className}>{label}
    <select value={value} onChange={(event) => onChange(Number(event.target.value) as Bitrate)}>
      <option value="64">Compact · 64 kbps</option>
      <option value="96">Recommended · 96 kbps</option>
      <option value="128">High · 128 kbps</option>
    </select>
  </label>;
}

export function DestinationSwitch({ value, onChange, hints }: { value: Destination; onChange: (value: Destination) => void; hints: Record<Destination, string> }) {
  return <fieldset className="destination-field full">
    <legend>Destination</legend>
    <div className="destination-switch">
      <button type="button" aria-pressed={value === 'output'} onClick={() => onChange('output')}><strong>Output folder</strong><small>{hints.output}</small></button>
      <button type="button" aria-pressed={value === 'download'} onClick={() => onChange('download')}><strong>Browser download</strong><small>{hints.download}</small></button>
    </div>
  </fieldset>;
}

export function EmptyState({ title, children, heading = 'h3' }: { title: string; children: ReactNode; heading?: 'h2' | 'h3' }) {
  const Heading = heading;
  return <div className="empty-state"><img src="/vertiku-icon.png" alt="" /><Heading>{title}</Heading><p>{children}</p></div>;
}
