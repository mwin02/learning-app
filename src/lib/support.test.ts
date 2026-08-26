// Unit tests for the mailto contact channel.

import { describe, it, expect } from 'vitest';
import { SUPPORT_EMAIL, supportMailto } from './support';

describe('supportMailto', () => {
  it('addresses the support inbox and encodes the subject', () => {
    expect(supportMailto({ subject: 'Broken link & 404' })).toBe(
      `mailto:${SUPPORT_EMAIL}?subject=Broken%20link%20%26%20404`
    );
  });

  it('encodes newlines and ampersands in the body so the query cannot be split', () => {
    const url = supportMailto({ subject: 'x', body: 'Reference: a&b\nWhere: /y' });
    expect(url).toContain('body=Reference%3A%20a%26b%0AWhere%3A%20%2Fy');
    expect(url.split('&')).toHaveLength(2); // only the subject/body separator
  });

  it('omits the body param entirely when there is nothing to prefill', () => {
    expect(supportMailto({ subject: 'x' })).not.toContain('body=');
  });
});
