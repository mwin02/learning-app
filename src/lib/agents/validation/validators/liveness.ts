// Liveness validator. Cheap network check that drops URLs which don't resolve
// to a live page. Generic HTTP: HEAD with a Range-GET fallback for servers
// that reject HEAD (some docs hosts return 403/405/501 on HEAD). YouTube:
// uses the oEmbed endpoint because removed videos still serve a 200 page.

import type { Validator, ValidatorVerdict, ValidatableResource } from '../types';

const LIVENESS_TIMEOUT_MS = 6000;

// A real browser UA, because some CDNs (Cloudflare, Akamai) reject node's
// default `node` UA with 403/503. The exact string doesn't matter — what
// matters is that it doesn't look like a bot.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export const livenessValidator: Validator = {
  id: 'liveness',
  cost: 'cheap',
  async validate(rows: ValidatableResource[]): Promise<ValidatorVerdict[]> {
    return Promise.all(
      rows.map(async (r): Promise<ValidatorVerdict> => {
        const alive = await isUrlLive(r.url);
        return alive
          ? { url: r.url, valid: true }
          : { url: r.url, valid: false, reason: 'url not reachable' };
      }),
    );
  },
};

async function isUrlLive(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) {
    return checkYouTube(url);
  }
  return checkHttp(url);
}

async function checkHttp(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    // Try HEAD first — cheap, no body. But HEAD is advisory: many servers
    // mishandle it (415, 400, even 500) on URLs that GET happily. So treat
    // *any* non-2xx HEAD as inconclusive and fall through to a Range-GET
    // that pulls a single byte. Only declare dead if GET also fails.
    try {
      const head = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: ctl.signal,
        headers: { 'User-Agent': UA, Accept: '*/*' },
      });
      if (head.ok) return true;
    } catch {
      // HEAD threw (some servers reset the connection on HEAD). Fall through.
    }
    const get = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-0' },
    });
    return get.ok || get.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function checkYouTube(url: string): Promise<boolean> {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await fetch(oembed, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
