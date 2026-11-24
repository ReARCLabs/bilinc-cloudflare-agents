export const EMPTY_TITLE = "What should I remember?";
export const EMPTY_LINE = "Everything you save is versioned: checkpoint it, diff it, roll it back.";
export const SUGGESTIONS = ["Remember that my favourite tea is Earl Grey.", "What do you remember about me?", "Checkpoint now."] as const;

/** The empty chat: a title, one line and three suggestions that fill the composer (they do not send). */
export function EmptyState({ onPick }: { onPick(text: string): void }) {
  return (
    <section className="empty">
      <h2>{EMPTY_TITLE}</h2>
      <p>{EMPTY_LINE}</p>
      <div className="suggest">
        {SUGGESTIONS.map((text) => (
          <button key={text} type="button" onClick={() => onPick(text)}>
            {text}
          </button>
        ))}
      </div>
    </section>
  );
}
