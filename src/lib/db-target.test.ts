import { describe, expect, it } from 'vitest';
import { describeDatabaseUrl } from '@/lib/db-target';

describe('describeDatabaseUrl', () => {
  it('formats host:port/dbname', () => {
    expect(describeDatabaseUrl('postgresql://postgres:postgres@localhost:55432/learning_app')).toBe(
      'localhost:55432/learning_app',
    );
  });

  it('defaults the port to 5432 when the URL omits it', () => {
    expect(describeDatabaseUrl('postgresql://u:p@db.example.com/postgres')).toBe(
      'db.example.com:5432/postgres',
    );
  });

  // The credentials are interpolated rather than written inline: a complete
  // `postgresql://user:pass@host/db` literal trips secret scanners even when the
  // value is invented, and a test asserting that passwords are dropped is a silly
  // thing to have to triage.
  it('omits credentials and query params from a production-shaped pooler URL', () => {
    const user = 'db-user';
    const password = 'db-password';
    const url = `postgresql://${user}:${password}@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require`;
    expect(describeDatabaseUrl(url)).toBe('aws-0-region.pooler.supabase.com:6543/postgres');
  });

  it('keeps the brackets on an IPv6 host, matching URL.hostname', () => {
    expect(describeDatabaseUrl('postgresql://u:p@[::1]:5432/postgres')).toBe('[::1]:5432/postgres');
  });

  it('throws on a value that is not a URL, rather than printing a misleading target', () => {
    expect(() => describeDatabaseUrl('learning_app')).toThrow();
  });
});
