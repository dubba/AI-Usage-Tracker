/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { dayStartInstants, dayStartsFor } from "./day-boundaries";

const HOUR = 3_600_000;
const originalZone = process.env.TZ;

/** Runs `run` with the process in `zone`: `new Date(y, m, d)` is a local midnight of that zone. */
function inZone<T>(zone: string, run: () => T): T {
  process.env.TZ = zone;
  return run();
}

afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

/**
 * What the backend's `validate_day_starts` checks (`history/report.rs`), as the page sees it: 2 to 32
 * RFC 3339 instants, strictly increasing, each day 22 to 26 hours, and the last at most 26 hours
 * after now. Returns why they would be refused, or null.
 */
function backendRefusal(instants: string[], now: number): string | null {
  if (instants.length < 2 || instants.length > 32) return "count";
  if (!instants.every((instant) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(instant))) return "format";
  const times = instants.map((instant) => Date.parse(instant));
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap <= 0) return "order";
    if (gap < 22 * HOUR || gap > 26 * HOUR) return `length ${gap / HOUR}h`;
  }
  return times[times.length - 1] > now + 26 * HOUR ? "future" : null;
}

const gapsInHours = (starts: Date[]) =>
  starts.slice(1).map((start, index) => (start.getTime() - starts[index].getTime()) / HOUR);

describe("dayStartsFor", () => {
  it("is the last N local days, today included: N + 1 midnights ending at tomorrow's", () => {
    inZone("UTC", () => {
      const now = new Date(2026, 9, 24, 15, 30);
      const starts = dayStartsFor(7, now);
      expect(starts).toHaveLength(8);
      expect(starts[0].toISOString()).toBe("2026-10-18T00:00:00.000Z");
      expect(starts[6].toISOString()).toBe("2026-10-24T00:00:00.000Z");
      expect(starts[7].toISOString()).toBe("2026-10-25T00:00:00.000Z");
      expect(dayStartsFor(30, now)).toHaveLength(31);
      expect(dayStartsFor(30, now)[0].toISOString()).toBe("2026-09-25T00:00:00.000Z");
    });
  });

  it("keeps today as the last day right at midnight and a second before it", () => {
    inZone("UTC", () => {
      const atMidnight = dayStartsFor(7, new Date(2026, 9, 24, 0, 0, 0));
      expect(atMidnight[6].toISOString()).toBe("2026-10-24T00:00:00.000Z");
      const lastSecond = dayStartsFor(7, new Date(2026, 9, 24, 23, 59, 59));
      expect(lastSecond[6].toISOString()).toBe("2026-10-24T00:00:00.000Z");
      expect(lastSecond[7].toISOString()).toBe("2026-10-25T00:00:00.000Z");
    });
  });

  it("crosses month and year ends", () => {
    inZone("UTC", () => {
      const starts = dayStartsFor(7, new Date(2027, 0, 3, 9));
      expect(starts.map((start) => start.toISOString().slice(0, 10))).toEqual([
        "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04",
      ]);
    });
  });

  it("has a 25 hour day when the clocks go back (New York, 2026-11-01)", () => {
    inZone("America/New_York", () => {
      const now = new Date(2026, 10, 1, 12);
      for (const count of [7, 30]) {
        const starts = dayStartsFor(count, now);
        const gaps = gapsInHours(starts);
        expect(gaps.filter((gap) => gap === 25)).toHaveLength(1);
        expect(gaps.at(-1)).toBe(25);
        expect(gaps.every((gap) => gap === 24 || gap === 25)).toBe(true);
        // Tomorrow's local midnight is 05:00 UTC once the clocks are back to standard time.
        expect(starts.at(-1)!.toISOString()).toBe("2026-11-02T05:00:00.000Z");
        expect(backendRefusal(dayStartInstants(starts), now.getTime())).toBeNull();
      }
    });
  });

  it("has a 23 hour day when the clocks go forward (New York, 2026-03-08)", () => {
    inZone("America/New_York", () => {
      const now = new Date(2026, 2, 8, 12);
      for (const count of [7, 30]) {
        const starts = dayStartsFor(count, now);
        const gaps = gapsInHours(starts);
        expect(gaps.filter((gap) => gap === 23)).toHaveLength(1);
        expect(gaps.at(-1)).toBe(23);
        expect(starts.at(-1)!.toISOString()).toBe("2026-03-09T04:00:00.000Z");
        expect(backendRefusal(dayStartInstants(starts), now.getTime())).toBeNull();
      }
    });
  });

  it("is a week of 24 hour days in Asia/Kolkata (+5:30)", () => {
    inZone("Asia/Kolkata", () => {
      const now = new Date(2026, 9, 24, 8);
      const starts = dayStartsFor(7, now);
      expect(gapsInHours(starts).every((gap) => gap === 24)).toBe(true);
      expect(starts[0].toISOString()).toBe("2026-10-17T18:30:00.000Z");
      expect(dayStartInstants(starts).every((instant) => instant.endsWith("T18:30:00.000Z"))).toBe(true);
      expect(backendRefusal(dayStartInstants(starts), now.getTime())).toBeNull();
    });
  });

  it("is a month of 24 hour days in Asia/Kathmandu (+5:45)", () => {
    inZone("Asia/Kathmandu", () => {
      const now = new Date(2026, 9, 24, 8);
      const starts = dayStartsFor(30, now);
      expect(gapsInHours(starts).every((gap) => gap === 24)).toBe(true);
      expect(dayStartInstants(starts).every((instant) => instant.endsWith("T18:15:00.000Z"))).toBe(true);
      expect(backendRefusal(dayStartInstants(starts), now.getTime())).toBeNull();
    });
  });

  it("passes the backend's rules in zones far east and west of UTC, in both periods", () => {
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Australia/Lord_Howe", "Europe/London", "America/Sao_Paulo"]) {
      inZone(zone, () => {
        for (const now of [new Date(2026, 9, 24, 0, 0, 1), new Date(2026, 9, 24, 23, 59, 59), new Date(2026, 3, 5, 12)]) {
          for (const count of [7, 30]) {
            const instants = dayStartInstants(dayStartsFor(count, now));
            expect(backendRefusal(instants, now.getTime()), `${zone} ${now.toISOString()} ${count}d`).toBeNull();
          }
        }
      });
    }
  });

  it("makes the check above able to fail: it refuses boundaries the backend would", () => {
    const now = Date.UTC(2026, 9, 24, 12);
    const day = (offset: number) => new Date(Date.UTC(2026, 9, 24 + offset)).toISOString();
    expect(backendRefusal([day(0)], now)).toBe("count");
    expect(backendRefusal([day(1), day(0)], now)).toBe("order");
    expect(backendRefusal([day(-3), day(0)], now)).toMatch(/^length/);
    expect(backendRefusal([day(10), day(11)], now)).toBe("future");
    expect(backendRefusal(["2026-10-24T00:00:00", day(1)], now)).toBe("format");
  });
});

describe("dayStartInstants", () => {
  it("writes each boundary as a UTC instant that reads back as the same moment", () => {
    inZone("America/New_York", () => {
      const starts = dayStartsFor(7, new Date(2026, 9, 24, 15));
      const instants = dayStartInstants(starts);
      expect(instants[0]).toBe("2026-10-18T04:00:00.000Z");
      instants.forEach((instant, index) => expect(Date.parse(instant)).toBe(starts[index].getTime()));
    });
  });
});
