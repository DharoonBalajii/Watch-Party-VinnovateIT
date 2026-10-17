// Subtitles: .srt → WebVTT on the server, and a small WebVTT cue parser for the
// browser, which draws captions itself so they work over <video> and YouTube alike.

export interface Cue {
  start: number; // seconds
  end: number;
  text: string;
}

const TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
function secs(t: string): number {
  const m = TIME.exec(t);
  if (!m) return NaN;
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}
const stamp = (s: number) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

/** Parse SRT or WebVTT text into cues (sorted, tags stripped except line breaks). */
export function parseCues(text: string): Cue[] {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = secs(a);
    const end = secs(b);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines.slice(i + 1).join('\n')
      .replace(/<[^>]*>/g, '') // <i>, <font>, <c.yellow>, voice tags
      .replace(/\{\\[^}]*\}/g, '') // {\an8} SSA-style overrides that SRT files carry
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .trim();
    if (body) cues.push({ start, end, text: body.slice(0, 500) });
  }
  return cues.sort((x, y) => x.start - y.start).slice(0, 20000);
}

export function toVtt(cues: Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

/** cues showing at time t (binary search on start, then scan back over overlaps) */
export function cuesAt(cues: Cue[], t: number): Cue[] {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1; else hi = mid;
  }
  const out: Cue[] = [];
  for (let i = lo - 1; i >= 0 && i >= lo - 8; i--) if (cues[i].end > t) out.unshift(cues[i]);
  return out;
}
