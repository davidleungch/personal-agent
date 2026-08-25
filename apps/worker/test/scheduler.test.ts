import { describe, expect, it } from "vitest";
import { nextOccurrence, previousOccurrence } from "../src/scheduler";

describe("timezone-aware occurrence calculation", () => {
  it("uses explicit IANA timezones independently of the host timezone", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "Pacific/Honolulu";
    const honoluluHost = nextOccurrence(
      "0 9 * * *",
      "Asia/Hong_Kong",
      new Date("2026-08-25T00:30:00.000Z")
    );
    process.env.TZ = "Europe/London";
    const londonHost = nextOccurrence(
      "0 9 * * *",
      "Asia/Hong_Kong",
      new Date("2026-08-25T00:30:00.000Z")
    );
    process.env.TZ = originalTimezone;

    expect(honoluluHost.toISOString()).toBe("2026-08-25T01:00:00.000Z");
    expect(londonHost).toEqual(honoluluHost);
  });

  it("moves a nonexistent spring-forward wall-clock occurrence through the DST gap", () => {
    expect(
      nextOccurrence(
        "30 2 * * *",
        "America/New_York",
        new Date("2026-03-07T07:30:00.000Z")
      ).toISOString()
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("runs once at the first fall-back wall-clock occurrence", () => {
    const first = nextOccurrence(
      "30 1 * * *",
      "America/New_York",
      new Date("2026-10-31T05:30:00.000Z")
    );
    const afterFirst = nextOccurrence("30 1 * * *", "America/New_York", first);

    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(afterFirst.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("includes an occurrence exactly at now when looking backward", () => {
    expect(
      previousOccurrence("0 9 * * *", "Asia/Hong_Kong", new Date("2026-08-25T01:00:00.000Z"))
    ).toEqual(new Date("2026-08-25T01:00:00.000Z"));
  });

  it("never selects the next minute before it is due", () => {
    expect(previousOccurrence("* * * * *", "UTC", new Date("2026-08-25T10:00:59.900Z"))).toEqual(
      new Date("2026-08-25T10:00:00.000Z")
    );
  });

  it("rejects non-five-field schedules", () => {
    expect(() => nextOccurrence("0 0 9 * * *", "UTC", new Date())).toThrow();
    expect(() => previousOccurrence("0 0 9 * * *", "UTC", new Date())).toThrow();
  });
});
