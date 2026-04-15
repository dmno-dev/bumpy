import pc from 'picocolors';

export const log = {
  info(msg: string) {
    console.log(`${pc.blue('info')} ${msg}`);
  },
  success(msg: string) {
    console.log(`${pc.green('done')} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${pc.yellow('warn')} ${msg}`);
  },
  error(msg: string) {
    console.error(`${pc.red('error')} ${msg}`);
  },
  step(msg: string) {
    console.log(`${pc.cyan('=>')} ${msg}`);
  },
  dim(msg: string) {
    console.log(pc.dim(msg));
  },
  bold(msg: string) {
    console.log(pc.bold(msg));
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
  return pc[color](text);
}
