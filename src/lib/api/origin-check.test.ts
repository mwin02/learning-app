import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedOrigin, requireSameOrigin } from '@/lib/api/origin-check';

describe('isAllowedOrigin', () => {
  it('passes when no Origin header is present (non-browser client)', () => {
    expect(isAllowedOrigin(null, 'app.example.com')).toBe(true);
    expect(isAllowedOrigin(null, null)).toBe(true);
  });

  it('passes when the Origin host matches the request host', () => {
    expect(isAllowedOrigin('https://app.example.com', 'app.example.com')).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
  });

  it('rejects a foreign Origin', () => {
    expect(isAllowedOrigin('https://evil.example.net', 'app.example.com')).toBe(false);
  });

  it('rejects when hosts differ only by port', () => {
    expect(isAllowedOrigin('http://localhost:4000', 'localhost:3000')).toBe(false);
  });

  it('rejects a subdomain of the request host', () => {
    expect(isAllowedOrigin('https://evil.app.example.com', 'app.example.com')).toBe(false);
  });

  it('rejects the literal "null" Origin (sandboxed iframe)', () => {
    expect(isAllowedOrigin('null', 'app.example.com')).toBe(false);
  });

  it('rejects an unparseable Origin', () => {
    expect(isAllowedOrigin('not a url', 'app.example.com')).toBe(false);
  });

  it('rejects a mismatched Origin when the request host is unknown', () => {
    expect(isAllowedOrigin('https://evil.example.net', null)).toBe(false);
  });

  it('passes when the Origin matches the APP_ORIGIN override', () => {
    expect(isAllowedOrigin('https://learn.example.com', 'internal.host', 'https://learn.example.com')).toBe(true);
  });

  it('accepts a bare-host APP_ORIGIN override (no scheme)', () => {
    expect(isAllowedOrigin('https://learn.example.com', 'internal.host', 'learn.example.com')).toBe(true);
  });

  it('rejects when the Origin matches neither host nor override', () => {
    expect(isAllowedOrigin('https://evil.example.net', 'app.example.com', 'https://learn.example.com')).toBe(false);
  });
});

describe('requireSameOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const req = (method: string, headers: Record<string, string>) =>
    new Request('https://app.example.com/api/x', { method, headers });

  it('skips safe methods entirely', () => {
    const r = req('GET', { origin: 'https://evil.example.net', host: 'app.example.com' });
    expect(requireSameOrigin(r)).toBeNull();
  });

  it('passes a mutating request with a matching Origin', () => {
    const r = req('POST', { origin: 'https://app.example.com', host: 'app.example.com' });
    expect(requireSameOrigin(r)).toBeNull();
  });

  it('passes a mutating request with no Origin header', () => {
    const r = req('POST', { host: 'app.example.com' });
    expect(requireSameOrigin(r)).toBeNull();
  });

  it('rejects a mutating request with a foreign Origin with 403', async () => {
    const r = req('POST', { origin: 'https://evil.example.net', host: 'app.example.com' });
    const res = requireSameOrigin(r);
    expect(res?.status).toBe(403);
    await expect(res!.json()).resolves.toMatchObject({ code: 'BAD_ORIGIN' });
  });

  it('prefers x-forwarded-host over host (proxy case)', () => {
    const r = req('POST', {
      origin: 'https://public.example.com',
      'x-forwarded-host': 'public.example.com',
      host: 'internal-lb.local',
    });
    expect(requireSameOrigin(r)).toBeNull();
  });

  it('honors the APP_ORIGIN env override', () => {
    vi.stubEnv('APP_ORIGIN', 'https://public.example.com');
    const r = req('POST', { origin: 'https://public.example.com', host: 'internal-lb.local' });
    expect(requireSameOrigin(r)).toBeNull();
  });
});
