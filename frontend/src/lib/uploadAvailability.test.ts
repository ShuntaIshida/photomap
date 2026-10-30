import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE, resolveApiBase } from './apiBase';
import { uploadAvailability } from './uploadAvailability';

const signedIn = { uid: 'u1' };
const base = { user: signedIn, authLoading: false, authConfigured: true, apiBase: DEFAULT_API_BASE };

describe('uploadAvailability', () => {
  it('is enabled for a signed-in user when the API is configured', () => {
    expect(uploadAvailability(base)).toEqual({ enabled: true });
  });

  it('is disabled when signed out, and tells the user to log in', () => {
    const r = uploadAvailability({ ...base, user: null });
    expect(r).toMatchObject({ enabled: false, reason: 'signed_out' });
    if (!r.enabled) expect(r.message).toContain('ログイン');
  });

  it('is disabled while the login state is still being restored (no flash of enabled)', () => {
    expect(uploadAvailability({ ...base, user: null, authLoading: true })).toMatchObject({ enabled: false, reason: 'auth_loading' });
    expect(uploadAvailability({ ...base, authLoading: true })).toMatchObject({ enabled: false, reason: 'auth_loading' });
  });

  it('is disabled when Firebase is not configured, regardless of any user', () => {
    expect(uploadAvailability({ ...base, authConfigured: false })).toMatchObject({ enabled: false, reason: 'firebase_unconfigured' });
  });

  it('explains a missing API URL even when the user is signed in (the case that looked like a dead button)', () => {
    const r = uploadAvailability({ ...base, apiBase: '' });
    expect(r).toMatchObject({ enabled: false, reason: 'api_unconfigured' });
    if (!r.enabled) expect(r.message).toContain('VITE_API_BASE_URL');
  });

  it('never enables uploads without a user', () => {
    for (const authLoading of [true, false]) {
      for (const authConfigured of [true, false]) {
        for (const apiBase of ['', DEFAULT_API_BASE]) {
          for (const user of [null, undefined]) {
            expect(uploadAvailability({ user, authLoading, authConfigured, apiBase }).enabled).toBe(false);
          }
        }
      }
    }
  });
});

describe('resolveApiBase', () => {
  it('falls back to the default Cloud Run URL when unset or empty (e.g. a copied .env.example)', () => {
    expect(resolveApiBase(undefined)).toBe(DEFAULT_API_BASE);
    expect(resolveApiBase('')).toBe(DEFAULT_API_BASE);
    expect(resolveApiBase('   ')).toBe(DEFAULT_API_BASE);
  });

  it('uses a custom URL and strips trailing slashes', () => {
    expect(resolveApiBase('http://localhost:8080')).toBe('http://localhost:8080');
    expect(resolveApiBase(' https://api.example.test/// ')).toBe('https://api.example.test');
  });

  it('default URL has no trailing slash and is https', () => {
    expect(DEFAULT_API_BASE).toMatch(/^https:\/\/[^/]+$/);
  });
});
