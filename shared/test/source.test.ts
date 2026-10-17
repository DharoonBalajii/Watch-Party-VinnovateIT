import { describe, expect, it } from 'vitest';
import { isValidSourceId, parseSourceInput, resolveSource } from '../src/source';

const id = (raw: string) => {
  const r = parseSourceInput(raw);
  return 'id' in r ? r.id : r.error;
};

describe('parseSourceInput', () => {
  it('reads every common YouTube link shape', () => {
    for (const raw of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'dQw4w9WgXcQ',
    ]) expect(id(raw), raw).toBe('yt:dQw4w9WgXcQ');
  });
  it('rejects YouTube pages that are not a single video', () => {
    expect(id('https://www.youtube.com/@somechannel')).toMatch(/doesn’t point to a video/);
  });
  it('accepts direct file links and refuses everything else', () => {
    expect(id('https://cdn.example.com/films/My%20Film.mp4')).toBe('url:https://cdn.example.com/films/My%20Film.mp4');
    expect(id('ftp://example.com/a.mp4')).toMatch(/http and https/);
    expect(id('javascript:alert(1)')).toMatch(/http and https/);
    expect(id('https://example.com/live.m3u8')).toMatch(/m3u8/);
    expect(id('not a link')).toMatch(/isn’t a link/);
  });
});

describe('isValidSourceId', () => {
  it('accepts catalog ids and canonical link ids only', () => {
    expect(isValidSourceId('sintel')).toBe(true);
    expect(isValidSourceId('yt:dQw4w9WgXcQ')).toBe(true);
    expect(isValidSourceId('yt:short')).toBe(false);
    expect(isValidSourceId('url:https://example.com/a.mp4')).toBe(true);
    expect(isValidSourceId('url:javascript:alert(1)')).toBe(false);
    expect(isValidSourceId('nope')).toBe(false);
    expect(isValidSourceId(42)).toBe(false);
  });
});

describe('resolveSource', () => {
  it('names a file link after its file and a YouTube video after its meta', () => {
    expect(resolveSource('url:https://cdn.example.com/films/my_holiday-2024.mp4')!.title).toBe('my holiday 2024');
    const yt = resolveSource('yt:dQw4w9WgXcQ', { title: 'A song', duration: 213 })!;
    expect(yt).toMatchObject({ kind: 'youtube', title: 'A song', runtime: 213, ytId: 'dQw4w9WgXcQ' });
    expect(resolveSource('sintel')!.movie?.title).toBe('Sintel');
  });
});
