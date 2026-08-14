import { describe, expect, it } from "vite-plus/test";
import { defaultConfig } from "../store/planner-store";
import { activeServiceReservations, setWiringExitMode } from "./service-reservations";

describe("wiring reservations", () => {
  it("uses one combined cable corridor by default", () => {
    const active = activeServiceReservations(defaultConfig.pack);
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe("wiring-exit");
    expect(active[0].face).toBe("negative-x");
    expect(active[0].sizeMm).toEqual([60, 34, 18]);
  });

  it("activates two distinct corridors only in separate mode", () => {
    const separate = setWiringExitMode(structuredClone(defaultConfig.pack), "separate");
    const active = activeServiceReservations(separate);
    expect(active).toHaveLength(2);
    expect(active.map((reservation) => reservation.kind)).toEqual([
      "power-output",
      "balance-harness",
    ]);
    expect(active[0].offsetMm).not.toEqual(active[1].offsetMm);
  });
});
