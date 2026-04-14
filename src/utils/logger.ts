const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

export const log = {
  info(msg: string) {
    console.log(`${BLUE}info${RESET} ${msg}`);
  },
  success(msg: string) {
    console.log(`${GREEN}done${RESET} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${YELLOW}warn${RESET} ${msg}`);
  },
  error(msg: string) {
    console.error(`${RED}error${RESET} ${msg}`);
  },
  step(msg: string) {
    console.log(`${CYAN}=>${RESET} ${msg}`);
  },
  dim(msg: string) {
    console.log(`${DIM}${msg}${RESET}`);
  },
  bold(msg: string) {
    console.log(`${BOLD}${msg}${RESET}`);
  },
  table(rows: string[][]) {
    if (rows.length === 0) return;
    const colWidths = rows[0]!.map((_, i) =>
      Math.max(...rows.map((r) => (r[i] ?? "").length))
    );
    for (const row of rows) {
      console.log(
        row.map((cell, i) => cell.padEnd(colWidths[i]!)).join("  ")
      );
    }
  },
};

export function colorize(text: string, color: "red" | "green" | "yellow" | "blue" | "cyan" | "dim" | "bold"): string {
  const codes: Record<string, string> = { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, cyan: CYAN, dim: DIM, bold: BOLD };
  return `${codes[color]}${text}${RESET}`;
}
