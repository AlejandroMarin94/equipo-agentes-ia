/** Límites que protegen la cuota gratuita y el tiempo máximo de Vercel. Sin dependencias de servidor. */
export const LIMITS = {
  maxTasks: 5,
  maxAttempts: 3,
  maxConsecutiveErrors: 3,
  maxCriteria: 6,
  /** Algo más que maxDuration (60 s) para que un paso colgado no deje el run bloqueado para siempre. */
  lockMs: 70_000,
  errorRetrySeconds: 3,
  busyRetrySeconds: 2,
  requestMinLength: 5,
  requestMaxLength: 500,
};
