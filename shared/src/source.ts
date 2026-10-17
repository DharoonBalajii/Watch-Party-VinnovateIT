// A "source" is anything the room can put on screen. Its id travels in PlaybackState.videoId:
//   catalog id       sintel
//   YouTube          yt:dQw4w9WgXcQ
//   direct file URL  url:https://example.com/film.mp4
//   uploaded file    up:9f86d081884c7d65   (served by our own server at /uploads/<id>)
import { CATALOG_BY_ID, type Movie } from './catalog';

export type SourceKind = 'catalog' | 'youtube' | 'url' | 'upload';

/** Facts the server learns after a source is loaded (YouTube title, reported duration). */
export interface SourceMeta {
  title?: string;
  author?: string;
  /** seconds, as reported by viewers' players */
  duration?: number;
}

export interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  /** short tag shown where a catalog film shows its year */
  label: string;
  /** seconds; 0 when not known yet */
  runtime: number;
  accent: [string, string];
  /** direct media URL (catalog and url kinds); a server-relative path for uploads */
  url?: string;
  ytId?: string;
  thumb?: string;
  movie?: Movie;
  silent?: boolean;
}

export const YT_PREFIX = 'yt:';
export const URL_PREFIX = 'url:';
export const UPLOAD_PREFIX = 'up:';
const UPLOAD_ID = /^[a-f0-9]{16}$/;
export const MAX_URL_LEN = 1000;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

const ACCENTS: [string, string][] = [
  ['#6FA8FF', '#1A1D6B'], ['#FF5C8A', '#4A1033'], ['#4EE6B5', '#0F4A3B'],
  ['#FFB347', '#5A2A0A'], ['#B58BFF', '#2E1760'], ['#FFD84A', '#4A3A05'],
];
function accentFor(id: string): [string, string] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(h) % ACCENTS.length];
}

function youTubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host === 'youtu.be') return u.pathname.split('/')[1] || null;
  if (!YT_HOSTS.has(host)) return null;
  if (u.pathname === '/watch') return u.searchParams.get('v');
  const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
  return m ? m[1] : null;
}

const isYouTubeHost = (host: string) => host === 'youtu.be' || YT_HOSTS.has(host.toLowerCase());

/** Turn whatever someone pasted into a source id, or explain why it can't play. */
export function parseSourceInput(raw: string): { id: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'Paste a YouTube link or a direct video link.' };
  if (YT_ID.test(text)) return { id: YT_PREFIX + text };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: 'That isn’t a link. Paste a full address starting with https://' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http and https links can play.' };
  if (isYouTubeHost(u.hostname)) {
    const id = youTubeId(u);
    return id && YT_ID.test(id) ? { id: YT_PREFIX + id } : { error: 'That YouTube link doesn’t point to a video. Open the video and copy its address.' };
  }
  if (/\.m3u8$/i.test(u.pathname)) return { error: 'Live streams (.m3u8) can’t play here yet. Use a .mp4 or .webm link.' };
  if (u.href.length > MAX_URL_LEN) return { error: 'That link is too long.' };
  return { id: URL_PREFIX + u.href };
}

/** Cheap structural check used by the server before accepting an id from a client. */
export function isValidSourceId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (CATALOG_BY_ID[id]) return true;
  if (id.startsWith(YT_PREFIX)) return YT_ID.test(id.slice(YT_PREFIX.length));
  if (id.startsWith(UPLOAD_PREFIX)) return UPLOAD_ID.test(id.slice(UPLOAD_PREFIX.length));
  if (id.startsWith(URL_PREFIX)) {
    const parsed = parseSourceInput(id.slice(URL_PREFIX.length));
    return 'id' in parsed && parsed.id === id;
  }
  return false;
}

function fileTitle(u: URL): string {
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  let name = last;
  try { name = decodeURIComponent(last); } catch { /* keep raw */ }
  name = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._-]+/g, ' ').trim();
  return name || u.hostname.replace(/^www\./, '');
}

export function resolveSource(id: string | null | undefined, meta?: SourceMeta): Source | null {
  if (!id) return null;
  const movie = CATALOG_BY_ID[id];
  if (movie) {
    return { id, kind: 'catalog', title: movie.title, label: String(movie.year), runtime: movie.runtime, accent: movie.accent, url: movie.url, movie, silent: movie.silent };
  }
  if (id.startsWith(YT_PREFIX)) {
    const ytId = id.slice(YT_PREFIX.length);
    if (!YT_ID.test(ytId)) return null;
    return {
      id, kind: 'youtube', ytId,
      title: meta?.title || 'YouTube video',
      label: meta?.author ? `YouTube · ${meta.author}` : 'YouTube',
      runtime: meta?.duration ?? 0,
      accent: accentFor(id),
      thumb: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
    };
  }
  if (id.startsWith(UPLOAD_PREFIX)) {
    const up = id.slice(UPLOAD_PREFIX.length);
    if (!UPLOAD_ID.test(up)) return null;
    return {
      id, kind: 'upload', url: `/uploads/${up}`,
      title: (meta?.title || 'Uploaded video').replace(/\.[a-z0-9]{2,5}$/i, ''),
      label: 'Upload',
      runtime: meta?.duration ?? 0,
      accent: accentFor(id),
    };
  }
  if (id.startsWith(URL_PREFIX)) {
    let u: URL;
    try { u = new URL(id.slice(URL_PREFIX.length)); } catch { return null; }
    return {
      id, kind: 'url', url: u.href,
      title: meta?.title || fileTitle(u),
      label: u.hostname.replace(/^www\./, ''),
      runtime: meta?.duration ?? 0,
      accent: accentFor(id),
    };
  }
  return null;
}
