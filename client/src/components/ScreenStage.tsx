import { stopScreenShare } from '../net/rtc';
import { getClient } from '../net/client';
import { useRoom } from '../store';
import { StreamVideo } from './StreamVideo';

/** Someone's screen, projected for the whole room in place of the film. */
export function ScreenStage() {
  const share = useRoom((s) => s.share);
  const youId = useRoom((s) => s.youId);
  const members = useRoom((s) => s.members);
  const localScreen = useRoom((s) => s.localScreen);
  const remote = useRoom((s) => (s.share ? s.remote[s.share.by]?.screen : undefined));
  const isHost = useRoom((s) => !!s.members.find((m) => m.id === s.youId)?.isHost);
  if (!share) return null;
  const mine = share.by === youId;
  const who = members.find((m) => m.id === share.by);
  const stream = mine ? localScreen : remote;
  const live = !!stream;

  return (
    <div className="screen" style={{ ['--c' as string]: who?.color }}>
      <StreamVideo stream={stream} muted={mine} className="screen__video" />
      {!live && (
        <div className="screen__wait">
          <span className="spinner spinner--lg" />
          <p>{mine ? 'Starting your screen…' : `Connecting to ${who?.name ?? 'their'} screen…`}</p>
        </div>
      )}
      <div className="screen__tag">
        <span className="screen__live mono">Live</span>
        <span>{mine ? 'You’re sharing your screen' : `${who?.name ?? 'Someone'}’s screen`}</span>
        {(mine || isHost) && (
          <button className="btn btn--sm btn--glass" onClick={() => (mine ? stopScreenShare() : getClient()?.send({ t: 'share', on: false }))}>
            {mine ? 'Stop sharing' : 'End share'}
          </button>
        )}
      </div>
    </div>
  );
}
