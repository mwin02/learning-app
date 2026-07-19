// Phase 2.5h-7: a collapsible per-concept question-bank viewer for the concept-map
// inspector. Native <details> so it needs no client JS (the page is a server
// component); operator-facing, so it shows everything (prompt + answer + rubric) —
// nothing is hidden behind a reveal here. Ad-hoc Tailwind to match the surrounding
// playground page (which predates the design system).

type BankQuestion = {
  id: string;
  kind: string;
  prompt: string;
  answer: string;
  rubric: string;
  origin: string;
};

const KIND_STYLE: Record<string, string> = {
  text: 'bg-purple-100 text-purple-800',
  mcq: 'bg-blue-100 text-blue-800',
};

const ORIGIN_STYLE: Record<string, string> = {
  agent: 'bg-gray-100 text-gray-600',
  user: 'bg-green-100 text-green-800',
};

export function QuestionBankBox({
  questions,
  bankReviewed,
}: {
  questions: BankQuestion[];
  bankReviewed: boolean;
}) {
  return (
    <details className="mt-2 rounded border border-gray-200 bg-gray-50">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-gray-700">
        Question bank ({questions.length})
        {bankReviewed ? (
          <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-green-800">reviewed</span>
        ) : (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">unreviewed</span>
        )}
      </summary>

      {questions.length === 0 ? (
        <div className="px-3 pb-3 text-xs text-gray-400">
          no questions yet — generated at spine-readiness, or authored via the discovery API
        </div>
      ) : (
        <ol className="flex flex-col gap-2 px-3 pb-3">
          {questions.map((q, i) => (
            <li key={q.id} className="rounded border border-gray-200 bg-white p-2 text-xs">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-gray-400">{i + 1}.</span>
                <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_STYLE[q.kind] ?? ''}`}>
                  {q.kind}
                </span>
                <span className={`rounded px-1.5 py-0.5 ${ORIGIN_STYLE[q.origin] ?? ''}`}>
                  {q.origin}
                </span>
              </div>
              {/* MCQ options are embedded in the prompt as A)/B)/... lines — preserve
                  the line breaks so they render as a list. */}
              <p className="whitespace-pre-line font-medium text-gray-800">{q.prompt}</p>
              <p className="mt-1 text-gray-600">
                <span className="font-semibold text-gray-500">Answer: </span>
                {q.answer}
              </p>
              <p className="mt-0.5 text-gray-500">
                <span className="font-semibold">Rubric: </span>
                {q.rubric}
              </p>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
