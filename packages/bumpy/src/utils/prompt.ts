import * as readline from "node:readline";

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface();
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`${question} [${hint}]`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

export async function select<T extends string>(
  question: string,
  options: { label: string; value: T }[],
): Promise<T> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i]!.label}`);
  }
  const answer = await ask("Choose");
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx]!.value;
  // Try matching by value
  const match = options.find((o) => o.value === answer || o.label.toLowerCase() === answer.toLowerCase());
  if (match) return match.value;
  // Default to first
  return options[0]!.value;
}

export async function multiSelect<T extends string>(
  question: string,
  options: { label: string; value: T; checked?: boolean }[],
): Promise<T[]> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    const mark = options[i]!.checked ? "[x]" : "[ ]";
    console.log(`  ${i + 1}) ${mark} ${options[i]!.label}`);
  }
  const answer = await ask("Select (comma-separated numbers, or 'all')");
  if (answer.toLowerCase() === "all") return options.map((o) => o.value);
  if (!answer) return options.filter((o) => o.checked).map((o) => o.value);
  const indices = answer.split(",").map((s) => parseInt(s.trim(), 10) - 1);
  return indices
    .filter((i) => i >= 0 && i < options.length)
    .map((i) => options[i]!.value);
}
