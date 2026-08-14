import { describe, expect, it } from "vite-plus/test";
import { cellsLibrary, componentsLibrary } from "./library";

describe("JSON libraries", () => {
  it("loads unique versioned cell records with sleeved dimensions", () => {
    expect(cellsLibrary.map((cell) => cell.id)).toEqual([
      "eve-50pl",
      "molicel-p42a",
      "molicel-p45b",
    ]);
    expect(new Set(cellsLibrary.map((cell) => cell.id)).size).toBe(cellsLibrary.length);
    for (const cell of cellsLibrary) {
      expect(cell.sleevedDiameterMm).toBeGreaterThan(21);
      expect(cell.sleevedHeightMm).toBeGreaterThanOrEqual(70.2);
      expect(cell.source.dimensionBasis.length).toBeGreaterThan(10);
    }
  });

  it("includes VESC-based ESCs and editable generic blocks", () => {
    expect(
      componentsLibrary.filter((component) => component.category === "esc").length,
    ).toBeGreaterThanOrEqual(5);
    expect(componentsLibrary.some((component) => component.category === "bms")).toBe(true);
    expect(componentsLibrary.some((component) => component.category === "antispark")).toBe(true);
    expect(componentsLibrary.some((component) => component.category === "custom")).toBe(true);
  });

  it("supports independent mesh, texture, and procedural component visuals", () => {
    const visualKinds = new Set(
      componentsLibrary.map((component) => component.visual?.kind).filter(Boolean),
    );
    expect(visualKinds).toEqual(new Set(["stl", "top-texture", "procedural"]));

    const sourcedVisuals = componentsLibrary
      .map((component) => component.visual)
      .filter((visual) => visual?.kind === "stl" || visual?.kind === "top-texture");
    for (const visual of sourcedVisuals) {
      expect(visual?.source.creator.length).toBeGreaterThan(2);
      expect(visual?.source.licenseUrl).toMatch(/^https:\/\//);
    }
  });
});
