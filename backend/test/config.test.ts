import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { toRegions } from '../src/services/regions.js';

const base = {
  GOOGLE_OAUTH_CLIENT_ID: 'id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  OAUTH_REDIRECT_URI: 'https://api.example.test/oauth/google/callback',
  DRIVE_OWNER_EMAIL: 'Owner@Example.ac.jp',
};

describe('toRegions', () => {
  it('uses folder names as slugs and skips invalid or duplicate names', () => {
    const { regions, ignored } = toRegions([
      { id: '1', name: 'yurihonjo' },
      { id: '2', name: 'nikaho' },
      { id: '3', name: 'Upper' },
      { id: '4', name: 'has space' },
      { id: '5', name: '日本語' },
      { id: '6', name: 'dup' },
      { id: '7', name: 'dup' },
      { id: '8', name: 'a'.repeat(65) },
    ]);
    expect(regions.map((r) => r.slug)).toEqual(['nikaho', 'yurihonjo']);
    expect(ignored.filter((i) => i.reason === 'duplicate_name')).toHaveLength(2);
    expect(ignored.filter((i) => i.reason === 'invalid_slug')).toHaveLength(4);
  });
});

describe('loadConfig', () => {
  it('applies defaults and normalizes values', () => {
    const c = loadConfig(base);
    expect(c.driveParentFolderId).toBe('17pp81R43EeQOIpaOtNR0IAIRldykz-Fq');
    expect(c.driveOwnerEmail).toBe('owner@example.ac.jp');
    expect(c.port).toBe(8080);
    expect(c.corsAllowedOrigins).toContain('https://shuntaishida.github.io');
  });

  it('requires secrets, owner email and redirect URI', () => {
    for (const k of Object.keys(base)) {
      expect(() => loadConfig({ ...base, [k]: '' })).toThrow();
    }
  });

  it('rejects unsafe values', () => {
    expect(() => loadConfig({ ...base, OAUTH_REDIRECT_URI: 'http://api.example.test/cb' })).toThrow();
    expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: '*' })).toThrow();
    expect(() => loadConfig({ ...base, DRIVE_PARENT_FOLDER_ID: "x' or name contains '" })).toThrow();
  });
});
