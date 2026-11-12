import type { Concept } from '../education/concepts';

export function ConceptExplanation({ concept }: { concept: Concept | undefined }) {
  if (!concept) return <div className="gl-explain">No explanation available yet.</div>;
  return (
    <div className="gl-explain" data-testid="concept-explanation">
      <section>
        <h4>What is it?</h4>
        <p>{concept.what}</p>
      </section>
      <section>
        <h4>Why do games use it?</h4>
        <p>{concept.why}</p>
      </section>
      <section>
        <h4>How does it work?</h4>
        <p>{concept.how}</p>
      </section>
      <section>
        <h4>Try this</h4>
        <ul>
          {concept.tryThis.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>
      <section>
        <h4>What happens if we disable it?</h4>
        <p>{concept.disabled}</p>
        {concept.comparisonNote && <p className="gl-note">{concept.comparisonNote}</p>}
      </section>
      <section>
        <h4>How would AI Director use this?</h4>
        <p>{concept.director}</p>
      </section>
      <section>
        <h4>Guided challenge</h4>
        <p>{concept.challenge}</p>
      </section>
      <details>
        <summary>Advanced details</summary>
        <p>{concept.advanced}</p>
      </details>
    </div>
  );
}
