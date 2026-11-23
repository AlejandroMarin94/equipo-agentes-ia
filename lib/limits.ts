/** Límites que protegen la suscripción de Claude y el tiempo máximo de Vercel. Sin dependencias de servidor. */
export const LIMITS = {
  maxTasks: 5,
  maxAttempts: 3,
  maxConsecutiveErrors: 3,
  maxCriteria: 6,
  /** Algo más que maxDuration (300 s) para que un paso colgado no deje el run bloqueado para siempre. */
  lockMs: 320_000,
  errorRetrySeconds: 3,
  busyRetrySeconds: 2,
  requestMinLength: 5,
  requestMaxLength: 500,
};

const HOUR_MS = 3600 * 1000;

/**
 * Cuándo queda libre un hueco del límite global por hora: cuando la ejecución
 * que sobra más antigua sale de la ventana. `creations` va de más antigua a más reciente.
 */
export function hourlyLimitReleaseAt(creations: Date[], maxRunsPerHour: number): Date | null {
  if (creations.length < maxRunsPerHour) return null;
  return new Date(creations[creations.length - maxRunsPerHour].getTime() + HOUR_MS);
}
