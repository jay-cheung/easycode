type EmptyStateCopy = {
  noMessages: string
  startSession: string
  starterPrompts: string[]
}

export function EmptyState({ copy, onSelectPrompt }: { copy: EmptyStateCopy; onSelectPrompt: (prompt: string) => void }) {
  return <section className="empty-state">
    <h2>{copy.noMessages}</h2>
    <p>{copy.startSession}</p>
    <div className="starter-prompts">
      {copy.starterPrompts.map((prompt) => <button key={prompt} onClick={() => onSelectPrompt(prompt)} type="button">{prompt}</button>)}
    </div>
  </section>
}

