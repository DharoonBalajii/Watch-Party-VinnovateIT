import { describe, expect, it } from 'vitest';
import { cuesAt, parseCues, toVtt } from '../src/subtitles';

const SRT = `1
00:00:01,000 --> 00:00:03,500
<i>Hello</i> there

2
00:00:03,000 --> 00:00:05,000
{\\an8}Overlapping line
second row

3
00:01:02,250 --> 00:01:04,000
Fish &amp; chips
`;

describe('subtitles', () => {
  it('parses SRT, strips tags and overrides, keeps line breaks', () => {
    const cues = parseCues(SRT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, text: 'Hello there' });
    expect(cues[1].text).toBe('Overlapping line\nsecond row');
    expect(cues[2]).toMatchObject({ start: 62.25, text: 'Fish & chips' });
  });
  it('round-trips through WebVTT', () => {
    const vtt = toVtt(parseCues(SRT));
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:01:02.250 --> 00:01:04.000');
    expect(parseCues(vtt)).toEqual(parseCues(SRT));
  });
  it('finds every cue showing at a moment, overlaps included', () => {
    const cues = parseCues(SRT);
    expect(cuesAt(cues, 0.5)).toEqual([]);
    expect(cuesAt(cues, 3.2).map((c) => c.text)).toEqual(['Hello there', 'Overlapping line\nsecond row']);
    expect(cuesAt(cues, 63).map((c) => c.text)).toEqual(['Fish & chips']);
  });
  it('ignores junk and Windows line endings', () => {
    expect(parseCues('not subtitles at all')).toEqual([]);
    expect(parseCues('1\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n')).toHaveLength(1);
  });
});
