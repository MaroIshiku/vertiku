import type { Draft } from './types.js';

// Set while a session is active, so any API call that finds the session expired returns the user to sign-in.
let sessionExpiredHandler: (() => void) | undefined;
export function setSessionExpiredHandler(handler: (() => void) | undefined) { sessionExpiredHandler = handler; }

export const errorMessage = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

function problemMessage(text: string, fallback: string) {
  try { const problem = JSON.parse(text) as { message?: unknown }; return typeof problem.message === 'string' && problem.message ? problem.message : fallback; }
  catch { return fallback; }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401) sessionExpiredHandler?.();
    throw new Error(problemMessage(text, response.status === 413 ? 'The request is too large.' : 'The request failed.'));
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

/** POST with CSRF proof and a JSON body (an empty object when none is given). */
export const postJson = <T>(url: string, csrf: string, body: unknown = {}) =>
  requestJson<T>(url, { method: 'POST', headers: { 'x-csrf-token': csrf }, body: JSON.stringify(body) });

export function uploadDraft(files: File[], cover: File | undefined, csrf: string, progress: (value: number) => void): Promise<Draft> {
  return new Promise((resolve, reject) => {
    const data = new FormData();
    files.forEach((file) => data.append('files', file));
    if (cover) data.append('cover', cover);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/drafts');
    xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.addEventListener('progress', (event) => event.lengthComputable && progress(Math.round((event.loaded / event.total) * 100)));
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as Draft); } catch { reject(new Error('The server returned an unreadable upload result.')); }
        return;
      }
      if (xhr.status === 401) sessionExpiredHandler?.();
      // A reverse proxy may answer with HTML (for example 413), so never assume a JSON body.
      reject(new Error(problemMessage(xhr.responseText, xhr.status === 413 ? 'The upload exceeds the size allowed by the server or proxy.' : 'Upload failed.')));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed. Check the connection and try again.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload was cancelled.')));
    xhr.send(data);
  });
}
