import { describe, expect, it } from 'vitest';
import { resolvePublicOrigin } from './public-origin';

const base = {
  forwardedHost: null,
  forwardedProto: null,
  host: null,
  fallbackOrigin: 'https://0.0.0.0:8080',
};

describe('resolvePublicOrigin', () => {
  it('prefers APP_ORIGIN over every header', () => {
    expect(
      resolvePublicOrigin({
        ...base,
        appOrigin: 'https://app.example.com',
        forwardedHost: 'proxy.example.com',
        host: 'internal',
      })
    ).toBe('https://app.example.com');
  });

  it('accepts a bare-host APP_ORIGIN and assumes https', () => {
    expect(resolvePublicOrigin({ ...base, appOrigin: 'app.example.com' })).toBe(
      'https://app.example.com'
    );
  });

  it('falls through to headers when APP_ORIGIN is unparseable', () => {
    expect(
      resolvePublicOrigin({ ...base, appOrigin: 'http://[bad', forwardedHost: 'proxy.example.com' })
    ).toBe('https://proxy.example.com');
  });

  it('derives the origin from x-forwarded-host, defaulting the scheme to https', () => {
    expect(resolvePublicOrigin({ ...base, forwardedHost: 'learning-app.run.app' })).toBe(
      'https://learning-app.run.app'
    );
  });

  it('honors x-forwarded-proto', () => {
    expect(
      resolvePublicOrigin({ ...base, forwardedHost: 'localhost:3000', forwardedProto: 'http' })
    ).toBe('http://localhost:3000');
  });

  it('takes the first value when a proxy chain appends its own', () => {
    expect(
      resolvePublicOrigin({
        ...base,
        forwardedHost: 'public.example.com, inner.example.com',
        forwardedProto: 'https, http',
      })
    ).toBe('https://public.example.com');
  });

  it('prefers x-forwarded-host over Host', () => {
    expect(
      resolvePublicOrigin({ ...base, forwardedHost: 'public.example.com', host: 'internal:8080' })
    ).toBe('https://public.example.com');
  });

  it('uses Host when there is no forwarded header', () => {
    expect(resolvePublicOrigin({ ...base, host: 'public.example.com' })).toBe(
      'https://public.example.com'
    );
  });

  // The regression this module exists for: with no proxy headers and no
  // APP_ORIGIN, the container's own bind address is all that is left.
  it('falls back to the request origin when nothing else is available', () => {
    expect(resolvePublicOrigin(base)).toBe('https://0.0.0.0:8080');
  });
});
