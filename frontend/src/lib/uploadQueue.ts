export const UPLOAD_CONCURRENCY = 2;

export type WorkerResult = 'continue' | 'stop' | void;

/**
 * itemsを最大concurrency件ずつ順に処理する。1件の失敗は他に影響しない（workerが例外を投げた場合も続行）。
 * workerが'stop'を返すか、signalが中止されると、新しい項目の開始を止める（実行中の項目は完了を待つ）。
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<WorkerResult>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (!stopped && !signal?.aborted && next < items.length) {
      const item = items[next++]!;
      try {
        if ((await worker(item)) === 'stop') stopped = true;
      } catch {
        // 1件の予期しない失敗で残りを止めない。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}
