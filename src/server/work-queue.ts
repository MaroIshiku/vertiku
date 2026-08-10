export type WorkQueueOptions = {
  concurrency: number;
  claim: () => string | undefined;
  run: (id: string) => Promise<void>;
};

export function createWorkQueue(options: WorkQueueOptions) {
  let active = 0;
  let scheduled = false;
  let stopped = false;
  const idleWaiters = new Set<() => void>();

  const resolveIdle = () => {
    if (active !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const wake = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (!stopped && active < options.concurrency) {
        const id = options.claim();
        if (!id) break;
        active += 1;
        void options.run(id).finally(() => {
          active -= 1;
          resolveIdle();
          wake();
        });
      }
      resolveIdle();
    });
  };

  return {
    wake,
    active: () => active,
    async stop() {
      stopped = true;
      if (active === 0) return;
      await new Promise<void>((resolve) => idleWaiters.add(resolve));
    }
  };
}
