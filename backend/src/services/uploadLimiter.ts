import { errors } from '../errors.js';

/**
 * ユーザー単位のアップロード制限（インスタンス内メモリ）。
 * 時間あたりの試行回数と同時実行数を制限する。複数インスタンスでは合算されないため、Cloud Runの最大インスタンス数も絞る。
 */
export class UploadLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly maxPerWindow = 1000,
    private readonly windowMs = 60 * 60 * 1000,
    private readonly maxConcurrent = 2,
    private readonly now: () => number = Date.now,
  ) {}

  /** 許可されれば解放関数を返す。超過なら429。失敗した試行も回数に数える。 */
  acquire(uid: string): () => void {
    const t = this.now();
    const recent = (this.attempts.get(uid) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.maxPerWindow || (this.inflight.get(uid) ?? 0) >= this.maxConcurrent) {
      this.attempts.set(uid, recent);
      throw errors.rateLimited();
    }
    recent.push(t);
    this.attempts.set(uid, recent);
    this.inflight.set(uid, (this.inflight.get(uid) ?? 0) + 1);
    this.prune(t);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.inflight.get(uid) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(uid);
      else this.inflight.set(uid, n);
    };
  }

  private prune(t: number) {
    if (this.attempts.size < 5000) return;
    for (const [uid, list] of this.attempts) {
      if (!list.some((at) => t - at < this.windowMs) && !this.inflight.has(uid)) this.attempts.delete(uid);
    }
  }
}
