import { createVertex } from '@ai-sdk/google-vertex';

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
const credentialsJson = requireEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON');

let parsedCredentials: { client_email: string; private_key: string };
try {
  parsedCredentials = JSON.parse(credentialsJson);
} catch (err) {
  throw new Error(
    `GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${(err as Error).message}`,
  );
}

export const vertex = createVertex({
  project,
  location,
  googleAuthOptions: {
    credentials: {
      client_email: parsedCredentials.client_email,
      private_key: parsedCredentials.private_key,
    },
  },
});

export const geminiFlash = vertex('gemini-2.5-flash');
