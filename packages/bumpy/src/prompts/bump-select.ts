import * as readline from 'node:readline';
import pc from 'picocolors';
import type { BumpTypeWithNone } from '../types.ts';

/** 'skip' = not included in bump file at all, 'none' = explicitly included with type none */
export type BumpLevel = 'skip' | BumpTypeWithNone;

const LEVELS: BumpLevel[] = ['skip', 'none', 'patch', 'minor', 'major'];

export interface BumpSelectItem {
  name: string;
  version: string;
  changed: boolean;
  /** Pre-set level (e.g. from an existing bump file on the branch) */
  initialLevel?: BumpLevel;
}

export interface BumpSelectResult {
  name: string;
  type: BumpTypeWithNone;
}

/**
 * Custom interactive prompt for selecting bump levels for multiple packages.
 * - Up/Down arrows to navigate between packages
 * - Left/Right arrows to change the bump level
 * - Changed packages default to "patch", unchanged to "none"
 * - Enter to confirm
 * - Ctrl+C / Escape to cancel
 */
export async function bumpSelectPrompt(items: BumpSelectItem[]): Promise<BumpSelectResult[] | symbol> {
  // Build display order: changed first, then unchanged
  const changedEntries = items.map((item, idx) => ({ item, idx })).filter(({ item }) => item.changed);
  const unchangedEntries = items.map((item, idx) => ({ item, idx })).filter(({ item }) => !item.changed);
  const displayOrder = [...changedEntries, ...unchangedEntries];

  // State
  let cursor = 0;
  const levels: BumpLevel[] = items.map((item) =>
    item.initialLevel !== undefined ? item.initialLevel : item.changed ? 'patch' : 'skip',
  );

  return new Promise<BumpSelectResult[] | symbol>((resolve) => {
    const { stdin, stdout } = process;
    const rl = readline.createInterface({ input: stdin, terminal: true });

    // Hide cursor
    stdout.write('\x1B[?25l');

    let renderedLines = 0;

    function render(final = false) {
      // Clear previous render
      if (renderedLines > 0) {
        stdout.write(`\x1B[${renderedLines}A`); // Move up
        stdout.write('\x1B[0J'); // Clear from cursor to end
      }

      const lines: string[] = [];

      if (final) {
        lines.push(`${pc.green('◇')}  Bump levels selected`);
        const selected = displayOrder.filter(({ idx }) => levels[idx] !== 'skip');
        if (selected.length === 0) {
          lines.push(`${pc.dim('│')}  ${pc.dim('(none selected)')}`);
        } else {
          for (const { item, idx } of selected) {
            lines.push(`${pc.dim('│')}  ${pc.cyan(item.name)} ${pc.dim('→')} ${pc.bold(levels[idx])}`);
          }
        }
        lines.push(pc.dim('│'));
      } else {
        lines.push(`${pc.cyan('◆')}  Select bump levels`);
        lines.push(`${pc.dim('│')}  ${pc.dim('↑/↓ navigate · ←/→ change level · enter to confirm')}`);
        lines.push(`${pc.dim('│')}  ${pc.dim('0 skip current · x skip all · r reset all to defaults')}`);
        lines.push(pc.dim('│'));

        let displayIdx = 0;

        if (changedEntries.length > 0) {
          lines.push(`${pc.dim('│')}  ${pc.underline('Changed')}`);
          for (const { item, idx } of changedEntries) {
            lines.push(formatRow(item, levels[idx]!, cursor === displayIdx));
            displayIdx++;
          }
          if (unchangedEntries.length > 0) {
            lines.push(pc.dim('│'));
          }
        }

        if (unchangedEntries.length > 0) {
          lines.push(`${pc.dim('│')}  ${pc.underline('Unchanged')}`);
          for (const { item, idx } of unchangedEntries) {
            lines.push(formatRow(item, levels[idx]!, cursor === displayIdx));
            displayIdx++;
          }
        }

        lines.push(pc.dim('│'));
        const selectedCount = levels.filter((l) => l !== 'skip').length;
        lines.push(`${pc.dim('│')}  ${pc.dim(`${selectedCount} package${selectedCount !== 1 ? 's' : ''} selected`)}`);
        lines.push(`${pc.dim('└')}`);
      }

      const output = lines.join('\n') + '\n';
      stdout.write(output);
      renderedLines = lines.length;
    }

    function cleanup() {
      stdin.removeListener('keypress', onKeypress);
      rl.close();
      stdout.write('\x1B[?25h'); // Show cursor
      if (stdin.isTTY) stdin.setRawMode(false);
    }

    function finish(result: BumpSelectResult[] | symbol) {
      render(true);
      cleanup();
      resolve(result);
    }

    // Enable keypress events before setting up listeners
    readline.emitKeypressEvents(stdin, rl);

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    render();

    function onKeypress(_str: string | undefined, key: readline.Key) {
      if (!key) return;

      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        // Clear the render
        if (renderedLines > 0) {
          stdout.write(`\x1B[${renderedLines}A`);
          stdout.write('\x1B[0J');
        }
        stdout.write(`${pc.red('■')}  Cancelled\n`);
        const cancelSymbol = Symbol('cancel');
        resolve(cancelSymbol);
        return;
      }

      if (key.name === 'return') {
        const results: BumpSelectResult[] = [];
        for (let i = 0; i < items.length; i++) {
          if (levels[i] !== 'skip') {
            results.push({ name: items[i]!.name, type: levels[i] as BumpTypeWithNone });
          }
        }
        finish(results);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + displayOrder.length) % displayOrder.length;
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % displayOrder.length;
      } else if (key.name === 'right' || key.name === 'l') {
        const entry = displayOrder[cursor]!;
        const currentLevel = LEVELS.indexOf(levels[entry.idx]!);
        if (currentLevel < LEVELS.length - 1) {
          levels[entry.idx] = LEVELS[currentLevel + 1]!;
        }
      } else if (key.name === 'left' || key.name === 'h') {
        const entry = displayOrder[cursor]!;
        const currentLevel = LEVELS.indexOf(levels[entry.idx]!);
        if (currentLevel > 0) {
          levels[entry.idx] = LEVELS[currentLevel - 1]!;
        }
      } else if (_str === '0' || key.name === 'backspace') {
        // Set current item to skip (not included)
        const entry = displayOrder[cursor]!;
        levels[entry.idx] = 'skip';
      } else if (_str === 'r') {
        // Reset all to defaults
        for (let i = 0; i < items.length; i++) {
          levels[i] =
            items[i]!.initialLevel !== undefined ? items[i]!.initialLevel! : items[i]!.changed ? 'patch' : 'skip';
        }
      } else if (_str === 'x') {
        // Clear all — set everything to skip
        for (let i = 0; i < items.length; i++) {
          levels[i] = 'skip';
        }
      }

      render();
    }

    stdin.on('keypress', onKeypress);
  });
}

function formatRow(item: BumpSelectItem, level: BumpLevel, focused: boolean): string {
  const prefix = pc.dim('│');
  const pointer = focused ? pc.cyan('›') : ' ';
  const nameStr = focused ? pc.cyan(item.name) : item.name;
  const versionStr = pc.dim(`(${item.version})`);
  const levelStr = formatLevel(level, focused);

  return `${prefix}  ${pointer} ${nameStr} ${versionStr}  ${levelStr}`;
}

function formatLevel(level: BumpLevel, focused: boolean): string {
  if (!focused) {
    if (level === 'skip') return pc.dim('·');
    if (level === 'none') return pc.dim('none');
    if (level === 'major') return pc.red(level);
    if (level === 'minor') return pc.yellow(level);
    return pc.green(level);
  }

  // Show the level selector when focused
  const parts = LEVELS.map((l) => {
    if (l === level) {
      if (l === 'skip') return pc.bold(pc.dim('[skip]'));
      if (l === 'none') return pc.bold(pc.dim('[none]'));
      if (l === 'major') return pc.bold(pc.red(`[${l}]`));
      if (l === 'minor') return pc.bold(pc.yellow(`[${l}]`));
      return pc.bold(pc.green(`[${l}]`));
    }
    return pc.dim(l);
  });

  return `◄ ${parts.join(pc.dim(' · '))} ►`;
}
