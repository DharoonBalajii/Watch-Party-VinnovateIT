import { useEffect, useRef } from 'react';

/** A <video> bound to a live MediaStream (webcams, screen shares). */
export function StreamVideo({ stream, muted, className, mirror }: { stream: MediaStream | null | undefined; muted?: boolean; className?: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== (stream ?? null)) v.srcObject = stream ?? null;
    if (stream) v.play().catch(() => { /* waits for the next user gesture */ });
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} style={mirror ? { transform: 'scaleX(-1)' } : undefined} />;
}
