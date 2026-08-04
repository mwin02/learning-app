// Shared types for the discovered-resource validation pipeline.
//
// Validators receive the full batch of candidates and return per-row verdicts.
// Batch-only because: (a) LLM validators are naturally batch (one call for N
// rows is much cheaper than N calls), and (b) network validators that want
// per-item parallelism can just Promise.all internally — the interface stays
// uniform for the pipeline driver.

export type ValidatorCost = 'cheap' | 'medium' | 'expensive';

// `quarantine` marks a failure the validator is NOT confident enough to act on
// destructively. The row is still persisted and still reaches the review queue —
// it is only kept out of the attach set, so a learner never gets served it while
// a reviewer decides. Reserved for heuristic checks (soft-404 title sniffing,
// network timeouts); an authoritative failure (HTTP 404, YouTube oEmbed) omits it
// and drops the row outright. See validation/index.ts for how it propagates.
export type ValidatorVerdict =
  | { url: string; valid: true }
  | { url: string; valid: false; reason: string; quarantine?: boolean };

export type ValidatorResult = {
  validator: string;
  verdicts: ValidatorVerdict[];
};

// Anything the validators need to operate on. Keep this minimal — adding
// fields here means every validator's input grows.
export type ValidatableResource = {
  url: string;
  title: string;
  summary: string;
  type: string;
};

export interface Validator<T extends ValidatableResource = ValidatableResource> {
  readonly id: string;
  readonly cost: ValidatorCost;
  validate(rows: T[]): Promise<ValidatorVerdict[]>;
}
