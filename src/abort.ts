export interface TimedAbortSignal {
  signal: AbortSignal;
  didTimeout(): boolean;
  wasExternallyAborted(): boolean;
  dispose(): void;
}

export function createTimedAbortSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): TimedAbortSignal {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const abortFromExternal = (): void => {
    externallyAborted = true;
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    wasExternallyAborted: () => externallyAborted,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

export function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return signal?.aborted ? Promise.reject(abortReason(signal)) : Promise.resolve();
  }
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("Operation aborted", "AbortError");
}
