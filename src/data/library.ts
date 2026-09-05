import type { CellSpec, ComponentSpec } from "../bindings";
import cellsJson from "./cells.json";
import componentsJson from "./components.json";

/**
 * Bundled libraries. The same JSON is embedded and validated by
 * `deckpack-core` (see `crates/deckpack-core/src/library.rs`), whose types
 * generate the bindings used here, so no second schema is kept in TypeScript.
 */
export const cellsLibrary = cellsJson.cells as unknown as CellSpec[];
export const componentsLibrary = componentsJson.components as unknown as ComponentSpec[];

export function getCell(id: string): CellSpec {
  return cellsLibrary.find((cell) => cell.id === id) ?? cellsLibrary[0];
}

export function getComponent(id: string): ComponentSpec {
  return componentsLibrary.find((component) => component.id === id) ?? componentsLibrary[0];
}
