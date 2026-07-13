import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import type { LanguageModel } from 'ai';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. See .env.example and docs/ROADMAP.md (Feature 1a).`,
    );
  }
  return value;
}

const project = requireEnv('GOOGLE_VERTEX_PROJECT');
const location = requireEnv('GOOGLE_VERTEX_LOCATION');

// Auth: an inline service-account key (GOOGLE_APPLICATION_CREDENTIALS_JSON —
// the full key JSON as one line; the local/.env.local and Vercel path) when
// set, otherwise Application Default Credentials. ADC is the containerized
// worker's path (Workers Block B): on Cloud Run the runtime service account
// via the metadata server — no key JSON ships in the image. Locally, ADC means
// `gcloud auth application-default login` or a GOOGLE_APPLICATION_CREDENTIALS
// file path.
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

let googleAuthOptions:
  | { credentials: { client_email: string; private_key: string } }
  | undefined;
if (credentialsJson) {
  let parsedCredentials: { client_email: string; private_key: string };
  try {
    parsedCredentials = JSON.parse(credentialsJson);
  } catch (err) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${(err as Error).message}`,
    );
  }
  googleAuthOptions = {
    credentials: {
      client_email: parsedCredentials.client_email,
      private_key: parsedCredentials.private_key,
    },
  };
}

export const vertex = createVertex({
  project,
  location,
  googleAuthOptions,
});

export const geminiFlash = vertex('gemini-2.5-flash');

// Anthropic's Claude models are first-party partner models in Vertex Model
// Garden, billed through the same GCP project (so GCP credits apply) and
// authenticated with the same service account. They are region-gated, though —
// our Gemini location (us-central1) does NOT host Claude — so they get their
// own location, defaulting to the `global` endpoint (which the provider serves
// from aiplatform.googleapis.com with no region prefix). Override with
// GOOGLE_VERTEX_ANTHROPIC_LOCATION (e.g. us-east5) if global is unavailable.
const anthropicLocation =
  process.env.GOOGLE_VERTEX_ANTHROPIC_LOCATION?.trim() || 'global';

export const vertexAnthropic = createVertexAnthropic({
  project,
  location: anthropicLocation,
  googleAuthOptions,
});

// Gemini 3.x models are NOT served from regional endpoints like us-central1
// (our default GOOGLE_VERTEX_LOCATION) — they live on the `global` endpoint, so
// a `gemini-3*` id against the regional provider 404s. They get their own
// provider pinned to `global` (aiplatform.googleapis.com, no region prefix).
// Override with GOOGLE_VERTEX_GEMINI3_LOCATION if a 3.x model lands in a region.
const gemini3Location =
  process.env.GOOGLE_VERTEX_GEMINI3_LOCATION?.trim() || 'global';

export const vertexGlobal = createVertex({
  project,
  location: gemini3Location,
  googleAuthOptions,
});

// Resolve a chat model id to the right Vertex provider:
//   claude-*    → Anthropic partner provider (own region)
//   gemini-3*   → global-endpoint Gemini provider (3.x isn't regional)
//   otherwise   → default regional Gemini provider (2.5 and earlier)
// Lets the per-agent REGISTRY in models.ts mix model families by id alone.
export function chatModel(modelId: string): LanguageModel {
  if (modelId.startsWith('claude-')) return vertexAnthropic(modelId);
  if (modelId.startsWith('gemini-3')) return vertexGlobal(modelId);
  return vertex(modelId);
}
