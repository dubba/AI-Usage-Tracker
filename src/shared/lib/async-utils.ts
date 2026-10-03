/**
 * Rejects with `message` if `promise` has not settled after `ms`. The timer is
 * always cleared, so a fast result leaves nothing pending. (The underlying call
 * is not canceled; Tauri commands cannot be aborted.)
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
