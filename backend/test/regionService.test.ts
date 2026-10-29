import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errors } from '../src/errors.js';
import type { DriveFolder, DriveGateway } from '../src/services/driveGateway.js';
import { RegionService } from '../src/services/regions.js';

class FlakyGateway implements DriveGateway {
  folders: DriveFolder[] = [{ id: 'f1', name: 'yurihonjo' }];
  failing = false;
  calls = 0;
  async isAuthorized() {
    return true;
  }
  async listChildFolders() {
    this.calls++;
    if (this.failing) throw errors.driveUnavailable();
    return this.folders;
  }
}

describe('RegionService failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the last good list when Drive fails (never an empty list)', async () => {
    const gw = new FlakyGateway();
    const svc = new RegionService(gw);
    await svc.list();
    gw.failing = true;
    vi.advanceTimersByTime(61_000);
    const res = await svc.list();
    expect(res.regions.map((r) => r.slug)).toEqual(['yurihonjo']);
  });

  it('does not hammer Drive right after a failure', async () => {
    const gw = new FlakyGateway();
    const svc = new RegionService(gw);
    await svc.list();
    gw.failing = true;
    vi.advanceTimersByTime(61_000);
    await svc.list();
    await svc.list();
    await svc.list();
    expect(gw.calls).toBe(2);
    vi.advanceTimersByTime(11_000);
    await svc.list();
    expect(gw.calls).toBe(3);
  });

  it('picks up added and removed folders after the cache expires', async () => {
    const gw = new FlakyGateway();
    const svc = new RegionService(gw);
    await svc.list();
    gw.folders = [{ id: 'f2', name: 'nikaho' }];
    vi.advanceTimersByTime(61_000);
    expect((await svc.list()).regions.map((r) => r.slug)).toEqual(['nikaho']);
  });

  it('throws when there is no previous good list', async () => {
    const gw = new FlakyGateway();
    gw.failing = true;
    await expect(new RegionService(gw).list()).rejects.toMatchObject({ code: 'drive_unavailable' });
  });

  it('stops serving stale data after 24 hours', async () => {
    const gw = new FlakyGateway();
    const svc = new RegionService(gw);
    await svc.list();
    gw.failing = true;
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    await expect(svc.list()).rejects.toMatchObject({ code: 'drive_unavailable' });
  });

  it('admin (fresh) listing surfaces failures instead of stale data', async () => {
    const gw = new FlakyGateway();
    const svc = new RegionService(gw);
    await svc.list();
    gw.failing = true;
    await expect(svc.list({ fresh: true })).rejects.toMatchObject({ code: 'drive_unavailable' });
  });
});
