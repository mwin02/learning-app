// Phase 2.5h: the single source of truth for the "MCQ options live inside the
// prompt" contract. The bank has no options column — an MCQ embeds its choices in
// `prompt` as lines labelled `A)`, `B)`, … so the reveal-only renderer can show
// them. A prompt missing ≥2 lettered options is an unanswerable MCQ, so every place
// that authors or accepts one (the LLM author, the discovery API, the verify
// scripts) gates on this one helper. Heuristic, not a parser: it matches an
// uppercase letter followed by `)` or `.` at the start of a line.
export function mcqHasOptions(prompt: string): boolean {
  return (prompt.match(/(^|\n)\s*[A-Z][)\.]/g)?.length ?? 0) >= 2;
}
