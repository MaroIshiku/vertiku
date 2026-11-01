export const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;

export function formatEstimate(seconds: number) {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.max(1, Math.round(seconds / 60)); const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  return hours ? `${hours} hr${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}` : `${minutes} min`;
}

export const finishTime = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'calculating';

export const formatSourceSize = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'];
export const isSupportedAudio = (file: File) => AUDIO_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension));

export const naturalCompare = (left: string, right: string) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
