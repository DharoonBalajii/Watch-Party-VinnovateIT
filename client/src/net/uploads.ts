import type { RoomUpload, SubsInfo } from '@shared/protocol';
import { apiUrl, seatHeaders } from './client';

/** Upload a video file into the room. XHR rather than fetch, for upload progress. */
export function uploadVideo(file: File, onProgress: (sent: number) => void): { done: Promise<RoomUpload>; cancel(): void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<RoomUpload>((resolve, reject) => {
    xhr.open('POST', apiUrl('/api/uploads'));
    for (const [k, v] of Object.entries(seatHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: { error?: string } & Partial<RoomUpload> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as RoomUpload);
      else reject(new Error(body.error || `The upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(file);
  });
  return { done, cancel: () => xhr.abort() };
}

/** Read a subtitle file (old .srt files are often Windows-1252, not UTF-8) and attach it to a source. */
export async function uploadSubtitles(file: File, videoId: string): Promise<SubsInfo> {
  if (file.size > 3 * 1024 * 1024) throw new Error('That subtitle file is too big (3 MB max).');
  const bytes = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes);
  const res = await fetch(apiUrl('/api/subtitles'), {
    method: 'POST',
    headers: { ...seatHeaders(), 'X-Video': videoId, 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Couldn’t add those subtitles.');
  return body as SubsInfo;
}

export interface YouTubeResult { id: string; title: string; channel: string; thumb: string; duration: number; live: boolean }

export async function searchYouTube(q: string, signal?: AbortSignal): Promise<YouTubeResult[]> {
  const res = await fetch(apiUrl(`/api/youtube/search?q=${encodeURIComponent(q)}`), { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || 'YouTube search failed.'); (e as Error & { code?: string }).code = body.code; throw e; }
  return body.items ?? [];
}

export const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
