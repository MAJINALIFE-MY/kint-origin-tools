// 依存追加なしの簡易並列数制限（p-limit 相当）。
// kintone は運用中ドメインの帯域を専有しない保守値として既定 5 並列とする
// （429 が出ても http.ts のリトライで自動回復する前提）。

export const DEFAULT_CONCURRENCY = 5;

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency は 1 以上の整数を指定してください: ${concurrency}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active -= 1;
    const resume = queue.shift();
    if (resume) resume();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

// items を最大 concurrency 並列で mapper に通す。
// 結果配列は items と同順（index 書き込み）＝出力 JSON のキー順・配列順を変えない（差分安定化）。
export async function mapWithLimit<T, R>(
  items: readonly T[],
  concurrency: number | Limiter,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limiter = typeof concurrency === "number" ? createLimiter(concurrency) : concurrency;
  const results = new Array<R>(items.length);
  await Promise.all(
    items.map((item, index) =>
      limiter(async () => {
        results[index] = await mapper(item, index);
      })
    )
  );
  return results;
}
