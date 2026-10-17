import { startScreenShare, stopScreenShare, toggleCam, toggleMic } from '../net/rtc';
import { selectCanControl, useRoom } from '../store';
import { cx } from '../util';

/** Your camera, microphone and screen: what you're putting into the room. */
export function AvBar() {
  const av = useRoom((s) => s.myAv);
  const sharing = useRoom((s) => s.share?.by === s.youId && !!s.localScreen);
  const otherSharing = useRoom((s) => !!s.share && s.share.by !== s.youId);
  const canControl = useRoom(selectCanControl);
  return (
    <div className="avbar" role="group" aria-label="Camera, microphone and screen">
      <button className={cx('avbtn', av.cam && 'is-on')} aria-pressed={av.cam} onClick={() => void toggleCam()} title={av.cam ? 'Turn camera off' : 'Turn camera on'}>
        <CamIcon off={!av.cam} /><span>Camera</span>
      </button>
      <button className={cx('avbtn', av.mic && 'is-on')} aria-pressed={av.mic} onClick={() => void toggleMic()} title={av.mic ? 'Mute your mic' : 'Unmute your mic'}>
        <MicIcon off={!av.mic} /><span>Mic</span>
      </button>
      <button
        className={cx('avbtn avbtn--share', sharing && 'is-on')}
        aria-pressed={sharing}
        disabled={!sharing && (otherSharing || !canControl)}
        onClick={() => void (sharing ? stopScreenShare() : startScreenShare())}
        title={otherSharing ? 'Someone else is sharing' : !canControl ? 'Only the host can share right now' : undefined}
      >
        <ScreenIcon /><span>{sharing ? 'Stop sharing' : 'Share screen'}</span>
      </button>
    </div>
  );
}

const I = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
export const CamIcon = ({ off }: { off?: boolean }) => (
  <I><rect x="3" y="6.5" width="12.5" height="11" rx="2.5" /><path d="m15.5 10.5 5-3v9l-5-3" />{off && <path d="M3 3l18 18" />}</I>
);
export const MicIcon = ({ off }: { off?: boolean }) => (
  <I><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />{off && <path d="M3 3l18 18" />}</I>
);
const ScreenIcon = () => (
  <I><rect x="3" y="4" width="18" height="12.5" rx="2" /><path d="M8.5 20h7M12 16.5V20M9.5 10.5 12 8l2.5 2.5M12 8v5.5" /></I>
);
