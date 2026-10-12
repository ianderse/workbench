import { describe, it, expect } from 'vitest';
import { computeTerminalGridLayout, type TerminalGridLayout } from '../terminal-grid-layout';

/** Each window's share of the grid's width and height, and whether the cells tile the grid */
function shares(layout: TerminalGridLayout) {
  const covered = new Set<string>();
  for (const cell of layout.cells) {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.column; c < cell.column + cell.columnSpan; c++) {
        const key = `${r},${c}`;
        expect(covered.has(key)).toBe(false);
        covered.add(key);
      }
    }
  }
  return {
    filled: covered.size === layout.rows * layout.columns,
    sizes: layout.cells.map((cell) => [cell.columnSpan / layout.columns, cell.rowSpan / layout.rows]),
  };
}

describe('computeTerminalGridLayout', () => {
  it('leaves no empty cell for any number of windows', () => {
    for (let count = 1; count <= 24; count++) {
      const layout = computeTerminalGridLayout(count);
      expect(layout.cells).toHaveLength(count);
      expect(shares(layout).filled).toBe(true);
    }
  });

  it('stretches the windows of a new bottom row across the whole width', () => {
    // 3 windows: two on top, the third as wide as both
    expect(shares(computeTerminalGridLayout(3)).sizes).toEqual([[1 / 2, 1 / 2], [1 / 2, 1 / 2], [1, 1 / 2]]);
    // 8 windows: 3 per row, the last row's two share it equally
    const eight = shares(computeTerminalGridLayout(8)).sizes;
    expect(eight.slice(0, 6).every(([w, h]) => w === 1 / 3 && h === 1 / 3)).toBe(true);
    expect(eight.slice(6)).toEqual([[1 / 2, 1 / 3], [1 / 2, 1 / 3]]);
  });

  it('stretches the windows of a new right column across the whole height', () => {
    // 5 windows: a 2x2 block and the fifth as tall as both rows on the right
    const five = computeTerminalGridLayout(5);
    expect(five.cells[4]).toEqual({ row: 1, rowSpan: 2, column: 3, columnSpan: 1 });
    expect(shares(five).sizes[4]).toEqual([1 / 3, 1]);
    // 11 windows: a 3x3 block and two on the right sharing its height
    const eleven = computeTerminalGridLayout(11);
    expect(shares(eleven).sizes.slice(9)).toEqual([[1 / 4, 1 / 2], [1 / 4, 1 / 2]]);
    expect(shares(eleven).sizes.slice(0, 9).every(([w, h]) => w === 1 / 4 && h === 1 / 3)).toBe(true);
  });

  it('keeps full grids as plain equal cells', () => {
    expect(computeTerminalGridLayout(1)).toEqual({ rows: 1, columns: 1, cells: [{ row: 1, rowSpan: 1, column: 1, columnSpan: 1 }] });
    expect(shares(computeTerminalGridLayout(2)).sizes).toEqual([[1 / 2, 1], [1 / 2, 1]]);
    expect(shares(computeTerminalGridLayout(9)).sizes.every(([w, h]) => w === 1 / 3 && h === 1 / 3)).toBe(true);
    expect(computeTerminalGridLayout(0)).toEqual({ rows: 0, columns: 0, cells: [] });
  });
});
