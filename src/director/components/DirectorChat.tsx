import { useEffect, useRef, useState } from 'react';
import { sendPrompt, useDirector } from '../state/directorStore';

const EXAMPLES = [
  'Walk to the table, pick up the glass, look around nervously and put it back on the table.',
  'Do it more slowly.',
  'Look around before putting down the glass.',
  'Pause before releasing the glass.',
  'Make the walk more exaggerated.',
  'Look to the left.',
];

export function DirectorChat() {
  const chat = useDirector((s) => s.project.chat);
  const ready = useDirector((s) => s.status === 'ready');
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.length]);
  const submit = (t = text) => {
    if (!t.trim()) return;
    sendPrompt(t);
    setText('');
  };
  return (
    <div className="ds-panel ds-chat">
      <h3>
        Director <span className="ds-tag" title="Runs entirely in the browser. No AI model or network service is used.">rule-based · offline</span>
      </h3>
      <div className="ds-messages" ref={list} data-testid="chat-messages">
        {chat.length === 0 && (
          <div className="ds-hint">
            Tell the actor what to do. The director understands walking, turning, reaching, picking up, placing and releasing the glass, looking, pausing, bending and idling, plus edits like “slower”, “more
            cautious” or “look around before putting it down”.
          </div>
        )}
        {chat.map((c) => (
          <div key={c.id} className={`ds-msg ${c.role} ${c.ok === false ? 'failed' : ''}`} data-testid={`chat-${c.role}`}>
            {c.text}
          </div>
        ))}
      </div>
      <div className="ds-examples">
        {EXAMPLES.map((e) => (
          <button key={e} className="ds-chip" disabled={!ready} onClick={() => submit(e)}>
            {e}
          </button>
        ))}
      </div>
      <form
        className="ds-compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={text}
          placeholder="e.g. Walk slowly to the table and pick up the glass"
          aria-label="Director instruction"
          data-testid="director-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="ds-btn ds-accent" disabled={!ready || !text.trim()} type="submit" data-testid="director-send">
          Direct
        </button>
      </form>
    </div>
  );
}
