import { useEffect, useRef, useState } from 'react';
import { sendPrompt, setLlmSettings, useDirector } from '../state/directorStore';
import { listModels } from '../ai/llmInterpreter';

const EXAMPLES = [
  'Walk to the table, pick up the glass, look around nervously and put it back on the table.',
  'Take at least 8 seconds.',
  'Do it more slowly.',
  'Make it twice as slow.',
  'Pause for 2 seconds before releasing the glass.',
  'Look around before putting down the glass.',
  'Make the walk more exaggerated.',
  'Look to the left.',
  'Walk to the table, sit down, then walk back.',
];

function ModelSettings() {
  const llm = useDirector((s) => s.llm);
  const [status, setStatus] = useState<string | null>(null);
  const test = async () => {
    setStatus('Connecting…');
    try {
      const models = await listModels(llm);
      setStatus(models.length ? `Connected. Models: ${models.join(', ')}${models.includes(llm.model) ? '' : ` (“${llm.model}” not found)`}` : 'Connected, but the server lists no models.');
    } catch (e) {
      setStatus(`Not reachable: ${(e as Error).message}`);
    }
  };
  return (
    <div className="ds-llm" data-testid="llm-settings">
      <label className="ds-check">
        <input type="checkbox" checked={llm.enabled} data-testid="llm-enabled" onChange={(e) => setLlmSettings({ enabled: e.target.checked })} />
        Use a local model (Ollama / LM Studio)
      </label>
      <label>
        Server URL
        <input value={llm.baseUrl} data-testid="llm-url" spellCheck={false} onChange={(e) => setLlmSettings({ baseUrl: e.target.value.trim() })} />
      </label>
      <label>
        Model
        <input value={llm.model} data-testid="llm-model" spellCheck={false} onChange={(e) => setLlmSettings({ model: e.target.value.trim() })} />
      </label>
      <div className="ds-row">
        <button type="button" className="ds-btn" onClick={() => void test()} data-testid="llm-test">
          Test connection
        </button>
        {status && <span className="ds-hint" data-testid="llm-status">{status}</span>}
      </div>
      <p className="ds-hint">
        Ollama: <code>ollama pull {DEFAULT_MODEL_HINT}</code>, URL <code>http://localhost:11434/v1</code>. LM Studio: start the local server (enable CORS), URL <code>http://localhost:1234/v1</code>. The model only proposes
        commands; they are validated like typed ones, and the rule-based parser takes over if the model fails.
      </p>
    </div>
  );
}

const DEFAULT_MODEL_HINT = 'qwen2.5:3b';

export function DirectorChat() {
  const chat = useDirector((s) => s.project.chat);
  const ready = useDirector((s) => s.status === 'ready');
  const thinking = useDirector((s) => s.thinking);
  const llm = useDirector((s) => s.llm);
  const [text, setText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.length, thinking]);
  const submit = (t = text) => {
    if (!t.trim() || thinking) return;
    void sendPrompt(t);
    setText('');
  };
  return (
    <div className="ds-panel ds-chat">
      <h3>
        Director{' '}
        {llm.enabled ? (
          <span className="ds-tag" data-testid="director-mode" title={`Instructions are interpreted by ${llm.model} at ${llm.baseUrl}; the rule-based parser is the fallback.`}>
            local model · {llm.model}
          </span>
        ) : (
          <span className="ds-tag" data-testid="director-mode" title="Runs entirely in the browser. No AI model or network service is used.">
            rule-based · offline
          </span>
        )}
        <button type="button" className="ds-icon-btn" aria-label="Model settings" aria-expanded={showSettings} data-testid="llm-toggle" onClick={() => setShowSettings((v) => !v)}>
          ⚙
        </button>
      </h3>
      {showSettings && <ModelSettings />}
      <div className="ds-messages" ref={list} data-testid="chat-messages">
        {chat.length === 0 && (
          <div className="ds-hint">
            Tell the actor what to do. The director understands walking, turning, reaching, picking up, placing and releasing the glass, looking, pausing, bending and idling, plus edits like “slower”, “more
            cautious” or “look around before putting it down”.
          </div>
        )}
        {chat.map((c) => (
          <div key={c.id} className={`ds-msg ${c.role} ${c.clarify ? 'clarify' : c.ok === false ? 'failed' : ''}`} data-testid={`chat-${c.role}`}>
            {c.text}
          </div>
        ))}
        {thinking && (
          <div className="ds-msg director thinking" data-testid="chat-thinking">
            Asking {llm.model}…
          </div>
        )}
      </div>
      <div className="ds-examples">
        {EXAMPLES.map((e) => (
          <button key={e} className="ds-chip" disabled={!ready || thinking} onClick={() => submit(e)}>
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
        <button className="ds-btn ds-accent" disabled={!ready || thinking || !text.trim()} type="submit" data-testid="director-send">
          Direct
        </button>
      </form>
    </div>
  );
}
