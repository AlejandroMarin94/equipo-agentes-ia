/** Formato de tiempos para mensajes y la interfaz. Sin dependencias de servidor ni de navegador. */

const madridTime = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });

export const formatMadridTime = (date: Date) => madridTime.format(date);

/** A partir de esta espera se dice también la hora a la que termina (cuota diaria agotada). */
export const LONG_WAIT_SECONDS = 3600;

/** Duración legible: «45 s», «3 min 20 s», «12 h 22 min». */
export function formatWait(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  // Se redondea al minuto de arriba para no prometer una hora antes de tiempo.
  const minutes = Math.ceil(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** «12 h 22 min (hasta las 08:15)» para esperas largas; «45 s» para las cortas. */
export function formatWaitUntil(totalSeconds: number, now: Date = new Date()): string {
  const text = formatWait(totalSeconds);
  if (totalSeconds < LONG_WAIT_SECONDS) return text;
  return `${text} (hasta las ${formatMadridTime(new Date(now.getTime() + totalSeconds * 1000))}, hora de Madrid)`;
}
