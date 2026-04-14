import { blue, green, yellow, red, cyan, dim, bold } from 'ansis';

export const log = {
  info(msg: string) {
    console.log(`${blue`info`} ${msg}`);
  },
  success(msg: string) {
    console.log(`${green`done`} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${yellow`warn`} ${msg}`);
  },
  error(msg: string) {
    console.error(`${red`error`} ${msg}`);
  },
  step(msg: string) {
    console.log(`${cyan`=>`} ${msg}`);
  },
  dim(msg: string) {
    console.log(dim`${msg}`);
  },
  bold(msg: string) {
    console.log(bold`${msg}`);
  },
  table(rows: string[][]) {
    if (rows.length === 0) return;
    const colWidths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
    for (const row of rows) {
      console.log(row.map((cell, i) => cell.padEnd(colWidths[i]!)).join('  '));
    }
  },
};

export function colorize(text: string, color: 'red' | 'green' | 'yellow' | 'blue' | 'cyan' | 'dim' | 'bold'): string {
  const colors = { red, green, yellow, blue, cyan, dim, bold };
  return colors[color](text);
}
