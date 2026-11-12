import { useRef } from 'react';
import type { Lane } from '../animation/motionComposer';
import { setLoop, setTime, togglePlay, useDirector } from '../state/directorStore';

const LANES: { id: Lane; label: string }[] = [
  { id: 'root', label: 'Actor Root' },
  { id: 'body', label: 'Body Motion' },
  { id: 'head', label: 'Head / Gaze' },
  { id: 'rightArm', label: 'Right Arm' },
  { id: 'leftArm', label: 'Left Arm' },
  { id: 'interaction', label: 'Object Interaction' },
  { id: 'glass', label: 'Glass Transform' },
  { id: 'events', label: 'Events' },
];

export function DirectorTimeline() {
  const perf = useDirector((s) => s.perf);
  const time = useDirector((s) => s.time);
  const playing = useDirector((s) => s.playing);
  const zoom = useDirector((s) => s.zoom);
  const loop = useDirector((s) => s.project.settings.loop);
  const selected = useDirector((s) => s.selectedAction);
  const area = useRef<HTMLDivElement>(null);
  const duration = perf?.duration ?? 0;
  const width = Math.max(600, (duration + 1) * zoom);

  const seekFromEvent = (clientX: number) => {
    const el = area.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTime((clientX - r.left + el.scrollLeft) / zoom);
  };

  return (
    <footer className="ds-timeline" data-testid="director-timeline">
      <div className="ds-transport">
        <button className="ds-btn" onClick={() => setTime(0)} disabled={!perf} title="Go to start">
          ⏮
        </button>
        <button className="ds-btn ds-accent" onClick={togglePlay} disabled={!perf || duration <= 0} data-testid="director-play">
          {playing ? 'Pause' : 'Play'}
        </button>
        <label className="ds-check">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
        </label>
        <span className="ds-time" data-testid="director-time">
          {time.toFixed(2)} / {duration.toFixed(2)} s
        </span>
        <input
          className="ds-scrub"
          type="range"
          min={0}
          max={duration || 0}
          step={1 / 60}
          value={time}
          aria-label="Scrub"
          data-testid="director-scrub"
          onChange={(e) => {
            useDirector.setState({ playing: false });
            setTime(parseFloat(e.target.value));
          }}
        />
        <span className="ds-zoom">
          <button className="ds-btn" onClick={() => useDirector.setState({ zoom: Math.max(20, zoom / 1.4) })} title="Zoom out">
            −
          </button>
          <button className="ds-btn" onClick={() => useDirector.setState({ zoom: Math.min(400, zoom * 1.4) })} title="Zoom in">
            +
          </button>
        </span>
      </div>
      <div className="ds-tracks">
        <div className="ds-lane-labels">
          <div className="ds-ruler-pad" />
          {LANES.map((l) => (
            <div key={l.id} className="ds-lane-label">
              {l.label}
            </div>
          ))}
        </div>
        <div className="ds-lanes" ref={area}>
          <div style={{ width, position: 'relative' }}>
            <div
              className="ds-ruler"
              onPointerDown={(e) => {
                useDirector.setState({ playing: false });
                seekFromEvent(e.clientX);
                const move = (ev: PointerEvent) => seekFromEvent(ev.clientX);
                const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
              }}
            >
              {Array.from({ length: Math.ceil(duration) + 2 }, (_, s) => (
                <span key={s} style={{ left: s * zoom }}>
                  {s}s
                </span>
              ))}
            </div>
            {LANES.map((l) => (
              <div key={l.id} className="ds-lane" data-testid={`lane-${l.id}`}>
                {perf?.items
                  .filter((it) => it.lane === l.id)
                  .map((it) =>
                    it.lane === 'events' ? (
                      <div key={it.id} className="ds-event" style={{ left: it.start * zoom }} title={`${it.label} @ ${it.start.toFixed(2)}s`}>
                        {it.label}
                      </div>
                    ) : (
                      <button
                        key={it.id}
                        className={`ds-clip lane-${l.id} ${it.actionId && it.actionId === selected ? 'sel' : ''}`}
                        style={{ left: it.start * zoom, width: Math.max(4, (it.end - it.start) * zoom - 2) }}
                        title={`${it.label}: ${it.start.toFixed(2)}–${it.end.toFixed(2)}s`}
                        data-testid={it.actionId ? `clip-${it.actionId}-${l.id}` : undefined}
                        onClick={() => it.actionId && useDirector.setState({ selectedAction: it.actionId, selectedObject: null })}
                      >
                        {it.label}
                      </button>
                    ),
                  )}
              </div>
            ))}
            <div className="ds-playhead" style={{ left: time * zoom }} />
          </div>
        </div>
      </div>
    </footer>
  );
}
