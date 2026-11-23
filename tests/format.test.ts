import { describe, expect, it } from "vitest";
import { formatWait, formatWaitUntil } from "@/lib/format";

describe("formato de esperas", () => {
  it("segundos, minutos y horas sin segundos crudos", () => {
    expect(formatWait(0)).toBe("0 s");
    expect(formatWait(14.2)).toBe("15 s");
    expect(formatWait(60)).toBe("1 min");
    expect(formatWait(200)).toBe("3 min 20 s");
    expect(formatWait(3600)).toBe("1 h");
    expect(formatWait(44_520)).toBe("12 h 22 min");
    expect(formatWait(44_500)).toBe("12 h 22 min"); // se redondea al minuto de arriba
  });

  it("en esperas largas dice hasta qué hora de Madrid", () => {
    const now = new Date("2026-11-23T10:00:00Z"); // 11:00 en Madrid
    expect(formatWaitUntil(90, now)).toBe("1 min 30 s");
    expect(formatWaitUntil(44_520, now)).toBe("12 h 22 min (hasta las 23:22, hora de Madrid)");
  });
});
