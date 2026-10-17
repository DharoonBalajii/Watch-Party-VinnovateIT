// YouTube search through the official Data API. The keys (YOUTUBE_API_KEY, comma-separated
// for more than one) stay on the server. A search costs ~101 of each key's 10,000 daily
// quota units, so results are cached, each visitor is rate-limited, and when one key runs
// out of quota the next one takes over.

export interface YouTubeResult {
  id: string;
  title: string;
  channel: string;
  thumb: string;
  /** seconds; 0 for live streams */
  duration: number;
  live: boolean;
}

export class YouTubeSearchError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'error') { super(message); }
}

const CACHE_MS = 6 * 3600 * 1000;
const cache = new Map<string, { at: number; items: YouTubeResult[] }>();
const perIp = new Map<string, number[]>();
/** key → when to try it again after it ran out of quota or was refused */
const benched = new Map<string, number>();
const BENCH_MS = 60 * 60 * 1000;

/** test hook */
export function resetYouTubeKeys() { benched.clear(); cache.clear(); perIp.clear(); }

const decode = (s: string) => s
  .replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** ISO-8601 duration (PT1H2M3S) → seconds */
export function isoDuration(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? '');
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export async function searchYouTube(raw: string, ip: string, keyList = process.env.YOUTUBE_API_KEY, now = Date.now()): Promise<YouTubeResult[]> {
  const keys = (keyList ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (!keys.length) throw new YouTubeSearchError(501, 'YouTube search isn’t set up on this server yet. Paste a YouTube link instead.', 'not_configured');
  const q = raw.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!q) return [];
  const k = q.toLowerCase();
  const hit = cache.get(k);
  if (hit && now - hit.at < CACHE_MS) return hit.items;

  // 12 fresh searches per visitor per 10 minutes
  const recent = (perIp.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 12) throw new YouTubeSearchError(429, 'That’s a lot of searches. Wait a few minutes, or paste a link.', 'rate_limited');
  recent.push(now);
  perIp.set(ip, recent);
  if (perIp.size > 5000) perIp.clear();

  // try each key in order, skipping ones that recently ran out of quota or were refused
  const api = async (path: string, params: Record<string, string>): Promise<unknown> => {
    let quotaHit = false;
    for (const key of keys) {
      if ((benched.get(key) ?? 0) > now) { quotaHit = true; continue; }
      const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) return r.json();
      const body = (await r.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
      const reason = body?.error?.errors?.[0]?.reason ?? '';
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') { quotaHit = true; benched.set(key, now + BENCH_MS); continue; }
      if (r.status === 400 || r.status === 403) { benched.set(key, now + BENCH_MS); console.warn(`[youtube] key …${key.slice(-4)} refused: ${reason || r.status}`); continue; }
      throw new YouTubeSearchError(502, 'YouTube search failed. Paste a link instead.');
    }
    if (quotaHit) throw new YouTubeSearchError(503, 'YouTube search has hit today’s limit. Paste a link instead, or try tomorrow.', 'quota');
    throw new YouTubeSearchError(502, 'YouTube search isn’t working right now. Paste a link instead.');
  };

  const found = (await api('search', {
    part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '15', safeSearch: 'moderate', q,
  })) as { items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; liveBroadcastContent?: string; thumbnails?: { medium?: { url?: string } } } }[] };
  const items = (found.items ?? []).filter((i) => i.id?.videoId);
  const ids = items.map((i) => i.id!.videoId!);
  const details = ids.length
    ? ((await api('videos', { part: 'contentDetails', id: ids.join(',') })) as { items?: { id: string; contentDetails?: { duration?: string } }[] })
    : { items: [] };
  const dur = new Map((details.items ?? []).map((d) => [d.id, isoDuration(d.contentDetails?.duration ?? '')]));

  const out: YouTubeResult[] = items.map((i) => ({
    id: i.id!.videoId!,
    title: decode(i.snippet?.title ?? ''),
    channel: decode(i.snippet?.channelTitle ?? ''),
    thumb: i.snippet?.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${i.id!.videoId}/mqdefault.jpg`,
    duration: dur.get(i.id!.videoId!) ?? 0,
    live: i.snippet?.liveBroadcastContent === 'live',
  }));
  cache.set(k, { at: now, items: out });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return out;
}
