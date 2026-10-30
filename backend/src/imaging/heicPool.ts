import { Worker } from 'node:worker_threads';
import { errors } from '../errors.js';
import { log } from '../logger.js';

export interface ConvertOptions {
  maxSide: number;
  quality: number;
}

export interface ConvertedImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface HeicConverter {
  toJpeg(heic: Buffer, options: ConvertOptions): Promise<ConvertedImage>;
}

export interface HeicPoolOptions {
  /** 同時に走らせるHEIC変換の数。WASMは1件あたり数百MB使うため既定は1。 */
  concurrency?: number;
  /** 待ち行列の上限。超えたら503を返す（過負荷でメモリを使い切らないため）。 */
  maxQueue?: number;
  /** 1件あたりの制限時間。 */
  timeoutMs?: number;
  /** これを超える画素数（幅×高さ）は処理しない。48MPのiPhoneを許容する。 */
  maxPixels?: number;
  workerUrl?: URL;
}

const DEFAULTS = { concurrency: 1, maxQueue: 6, timeoutMs: 30_000, maxPixels: 50_000_000 };

/**
 * HEIC→JPEG変換をワーカースレッドで実行するプール。
 * メインスレッドをブロックせず、同時実行数・待ち行列・時間・画素数を制限し、1ジョブごとにワーカーを終了してメモリを返す。
 */
export class HeicWorkerPool implements HeicConverter {
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly maxPixels: number;
  private readonly workerUrl: URL;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: HeicPoolOptions = {}) {
    this.concurrency = options.concurrency ?? DEFAULTS.concurrency;
    this.maxQueue = options.maxQueue ?? DEFAULTS.maxQueue;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxPixels = options.maxPixels ?? DEFAULTS.maxPixels;
    this.workerUrl = options.workerUrl ?? new URL('./heicWorker.mjs', import.meta.url);
  }

  async toJpeg(heic: Buffer, { maxSide, quality }: ConvertOptions): Promise<ConvertedImage> {
    await this.acquire();
    try {
      return await this.runWorker(heic, maxSide, quality);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(errors.conversionBusy());
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release() {
    this.running -= 1;
    this.waiting.shift()?.();
  }

  private runWorker(heic: Buffer, maxSide: number, quality: number): Promise<ConvertedImage> {
    return new Promise((resolve, reject) => {
      // 入力はコピーして渡す（呼び出し側のBufferを触らせない）。
      const input = new Uint8Array(heic);
      const worker = new Worker(this.workerUrl, { workerData: { input, maxSide, quality, maxPixels: this.maxPixels } });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // ワーカーを終了してWASMヒープごとメモリを解放する。
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => {
        log('WARNING', 'heic conversion timed out', { ms: this.timeoutMs });
        finish(() => reject(errors.imageDecodeFailed()));
      }, this.timeoutMs);

      worker.once('message', (msg: { ok: boolean; code?: string; data?: Uint8Array; width?: number; height?: number }) => {
        finish(() => {
          if (msg.ok && msg.data) {
            resolve({ data: Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength), width: msg.width!, height: msg.height! });
          } else if (msg.code === 'too_large') {
            reject(errors.imageTooLarge());
          } else {
            reject(errors.imageDecodeFailed());
          }
        });
      });
      worker.once('error', () => finish(() => reject(errors.imageDecodeFailed())));
      worker.once('exit', (code) => {
        if (code !== 0) finish(() => reject(errors.imageDecodeFailed()));
      });
    });
  }
}
