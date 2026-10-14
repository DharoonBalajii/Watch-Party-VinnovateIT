// Verifies every catalog URL answers 200/206 with byte-range support.
import { CATALOG } from '../shared/src/catalog';

let bad = 0;
await Promise.all(
  CATALOG.map(async (m) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(m.url, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
        const ok = (res.status === 206 || res.status === 200) && (res.headers.get('content-type') ?? '').includes('video');
        await res.body?.cancel();
        if (ok) return console.log(`ok   ${res.status} ${m.id}`);
        if (attempt === 3) { bad++; console.log(`FAIL ${res.status} ${m.id} ${res.headers.get('content-type')}`); }
      } catch (e) {
        if (attempt === 3) { bad++; console.log(`FAIL ${m.id} ${(e as Error).message}`); }
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }),
);
console.log(bad ? `\n${bad} broken` : '\nall catalog URLs OK');
process.exit(bad ? 1 : 0);
