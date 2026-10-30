import { describe, expect, it } from 'vitest';
import { probeAdmin } from './useIsAdmin';

const user = (claims: Record<string, unknown>) => ({ getIdToken: async () => 't', getIdTokenResult: async () => ({ token: 't', claims }) }) as never;
const fetchReturning = (ok: boolean) => (async () => ({ ok }) as Response) as unknown as typeof fetch;

describe('probeAdmin', () => {
  it('trusts the admin custom claim without a request', async () => {
    const fetchFn = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
    expect(await probeAdmin({ user: user({ admin: true }), apiBase: 'https://api.test', fetchFn })).toBe(true);
  });
  it('asks the server\'s existing admin check for ADMIN_UIDS admins', async () => {
    expect(await probeAdmin({ user: user({}), apiBase: 'https://api.test', fetchFn: fetchReturning(true) })).toBe(true);
    expect(await probeAdmin({ user: user({}), apiBase: 'https://api.test', fetchFn: fetchReturning(false) })).toBe(false);
  });
  it('is false without an API or on errors', async () => {
    expect(await probeAdmin({ user: user({}), apiBase: '' })).toBe(false);
    const boom = (async () => { throw new Error('x'); }) as unknown as typeof fetch;
    expect(await probeAdmin({ user: user({}), apiBase: 'https://api.test', fetchFn: boom })).toBe(false);
  });
});
