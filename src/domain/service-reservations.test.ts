import { describe, expect, it } from "vite-plus/test";
import { defaultConfig } from "../store/planner-store";
import { activeServiceReservations, normalizeWiringReservations } from "./service-reservations";
import type { PackRequest } from "./types";

describe("wiring reservation migration", () => {
  it("merges legacy power and balance keep-outs that shared one exit", () => {
    const current = structuredClone(defaultConfig.pack);
    const { wiringExitMode: _, ...legacy } = current;
    legacy.serviceReservations = legacy.serviceReservations
      .filter((reservation) => reservation.kind !== "wiring-exit")
      .map((reservation) => ({
        ...reservation,
        face: "negative-x" as const,
        offsetMm: [0, 0, 0],
      }));

    const migrated = normalizeWiringReservations(legacy);
    const active = activeServiceReservations(migrated);

    expect(migrated.wiringExitMode).toBe("combined");
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe("wiring-exit");
    expect(active[0].face).toBe("negative-x");
    expect(active[0].sizeMm).toEqual([60, 34, 18]);
  });

  it("preserves genuinely separate legacy exits as advanced mode", () => {
    const current = structuredClone(defaultConfig.pack);
    const { wiringExitMode: _, ...legacy } = current;
    legacy.serviceReservations = legacy.serviceReservations.filter(
      (reservation) => reservation.kind !== "wiring-exit",
    );
    legacy.serviceReservations[0].face = "positive-x";
    legacy.serviceReservations[1].face = "negative-x";

    const migrated = normalizeWiringReservations(legacy);

    expect(migrated.wiringExitMode).toBe("separate");
    expect(activeServiceReservations(migrated)).toHaveLength(2);
  });

  it("keeps the normalized shape compatible with PackRequest", () => {
    const normalized: PackRequest = normalizeWiringReservations(defaultConfig.pack);
    expect(normalized.serviceReservations).toHaveLength(3);
  });
});
