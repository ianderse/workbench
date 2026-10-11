/**
 * Layout of the agent windows grid (Agents page) without empty cells.
 *
 * The grid stays near-square (1x1, 1x2, 2x2, 2x3, 3x3, 3x4, ...) and grows either by a row or
 * by a column. The windows of the newest, unfilled line share it equally:
 * - a new bottom row (rows == columns): its windows split the whole width
 * - a new right column (columns > rows): its windows split the whole height
 * The other windows fill the block above / to the left of it in reading order.
 */

/** A window's place in the CSS grid (1-based lines, as grid-row / grid-column take them) */
export interface TerminalGridCell {
  row: number;
  rowSpan: number;
  column: number;
  columnSpan: number;
}

export interface TerminalGridLayout {
  /** Number of equal CSS grid rows */
  rows: number;
  /** Number of equal CSS grid columns */
  columns: number;
  /** One cell per window, in the windows' order */
  cells: TerminalGridCell[];
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

export function computeTerminalGridLayout(count: number): TerminalGridLayout {
  if (count <= 0) return { rows: 0, columns: 0, cells: [] };
  const cols = count === 2 ? 2 : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cells: TerminalGridCell[] = [];

  if (cols > rows) {
    // Grown by a column: a (cols - 1)-wide block, then the right column top to bottom
    const blockCols = cols - 1;
    const extra = count - rows * blockCols;
    const units = lcm(rows, extra);
    for (let i = 0; i < count - extra; i++) {
      cells.push({
        row: Math.floor(i / blockCols) * (units / rows) + 1,
        rowSpan: units / rows,
        column: (i % blockCols) + 1,
        columnSpan: 1,
      });
    }
    for (let j = 0; j < extra; j++) {
      cells.push({ row: j * (units / extra) + 1, rowSpan: units / extra, column: cols, columnSpan: 1 });
    }
    return { rows: units, columns: cols, cells };
  }

  // Grown by a row: a block of full rows, then the bottom row left to right
  const extra = count - cols * (rows - 1);
  const units = lcm(cols, extra);
  for (let i = 0; i < count - extra; i++) {
    cells.push({
      row: Math.floor(i / cols) + 1,
      rowSpan: 1,
      column: (i % cols) * (units / cols) + 1,
      columnSpan: units / cols,
    });
  }
  for (let j = 0; j < extra; j++) {
    cells.push({ row: rows, rowSpan: 1, column: j * (units / extra) + 1, columnSpan: units / extra });
  }
  return { rows, columns: units, cells };
}
