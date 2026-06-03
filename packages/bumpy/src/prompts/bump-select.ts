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

type Row =
  | { kind: 'header'; text: string }
  | { kind: 'separator' }
  | { kind: 'item'; itemIdx: number; displayIdx: number };

/**
 * Custom interactive prompt for selecting bump levels for multiple packages.
 * - Up/Down arrows to navigate between packages
 * - Left/Right arrows to change the bump level
 * - Changed packages default to "patch", unchanged to "none"
 * - Enter to confirm
 * - Ctrl+C / Escape to cancel
 *
 * Renders a viewport that fits within the terminal so the list scrolls instead of
 * overflowing — otherwise large package counts cause the redraw cursor-up to lose
 * its anchor once content scrolls off-screen.
 */
export async function bumpSelectPrompt(items: BumpSelectItem[]): Promise<BumpSelectResult[] | symbol> {
  // Build display order: changed first, then unchanged
  const changedEntries = items.map((item, idx) => ({ item, idx })).filter(({ item }) => item.changed);
  const unchangedEntries = items.map((item, idx) => ({ item, idx })).filter(({ item }) => !item.changed);
  const displayOrder = [...changedEntries, ...unchangedEntries];

  // Build a flat list of rows (headers, separators, items) — static structure used for windowing.
  const rows: Row[] = [];
  const itemRowIndex: number[] = []; // displayIdx -> index into rows
  {
    let displayIdx = 0;
    if (changedEntries.length > 0) {
      rows.push({ kind: 'header', text: 'Changed' });
      for (const { idx } of changedEntries) {
        itemRowIndex.push(rows.length);
        rows.push({ kind: 'item', itemIdx: idx, displayIdx });
        displayIdx++;
      }
      if (unchangedEntries.length > 0) {
        rows.push({ kind: 'separator' });
      }
    }
    if (unchangedEntries.length > 0) {
      rows.push({ kind: 'header', text: 'Unchanged' });
      for (const { idx } of unchangedEntries) {
        itemRowIndex.push(rows.length);
        rows.push({ kind: 'item', itemIdx: idx, displayIdx });
        displayIdx++;
      }
    }
  }

  // State
  let cursor = 0;
  let scroll = 0;
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
            lines.push(`${pc.dim('│')}  ${pc.cyan(item.name)} ${pc.dim('→')} ${pc.bold(levels[idx]!)}`);
          }
        }
        lines.push(pc.dim('│'));

        const output = lines.join('\n') + '\n';
        stdout.write(output);
        renderedLines = lines.length;
        return;
      }

      const headerChrome = [
        `${pc.cyan('◆')}  Select bump levels`,
        `${pc.dim('│')}  ${pc.dim('↑/↓ navigate · ←/→ change level · enter to confirm')}`,
        `${pc.dim('│')}  ${pc.dim('0 skip current · x skip all · r reset all to defaults')}`,
        pc.dim('│'),
      ];

      const selectedCount = levels.filter((l) => l !== 'skip').length;
      const footerChrome = [
        pc.dim('│'),
        `${pc.dim('│')}  ${pc.dim(`${selectedCount} package${selectedCount !== 1 ? 's' : ''} selected`)}`,
        pc.dim('└'),
      ];

      // Determine viewport size: how many body lines fit in the terminal.
      const termRows = stdout.rows || 24;
      const chromeLines = headerChrome.length + footerChrome.length;
      const MIN_BODY = 3;
      const availableBody = Math.max(MIN_BODY, termRows - chromeLines - 1);

      let visibleRows: Row[];
      let topIndicator: string | null = null;
      let bottomIndicator: string | null = null;
      let stickyHeader: string | null = null;

      if (rows.length <= availableBody) {
        visibleRows = rows;
        scroll = 0;
      } else {
        // Reserve up to 2 lines for scroll indicators (one above, one below).
        let windowSize = Math.max(MIN_BODY, availableBody - 2);
        const focusedRowIdx = itemRowIndex[cursor]!;

        const adjustScroll = () => {
          if (focusedRowIdx < scroll) {
            scroll = focusedRowIdx;
          } else if (focusedRowIdx >= scroll + windowSize) {
            scroll = focusedRowIdx - windowSize + 1;
          }
          scroll = Math.max(0, Math.min(scroll, rows.length - windowSize));
        };

        adjustScroll();

        // Sticky section header — if the focused item's section header has scrolled
        // out of view above the window, pin it just below the ▲ indicator so the
        // user always sees which section they're in.
        const section = getCurrentSection(cursor, changedEntries.length, unchangedEntries.length);
        if (section !== null && section.headerRowIdx < scroll) {
          // Reserve one more line for the sticky header and re-adjust scroll
          windowSize = Math.max(MIN_BODY, windowSize - 1);
          adjustScroll();
          stickyHeader = `${pc.dim('│')}  ${pc.underline(section.name)}`;
        }

        visibleRows = rows.slice(scroll, scroll + windowSize);
        const above = scroll;
        const below = rows.length - (scroll + windowSize);
        if (above > 0) topIndicator = `${pc.dim('│')}  ${pc.dim(`▲ ${above} more`)}`;
        if (below > 0) bottomIndicator = `${pc.dim('│')}  ${pc.dim(`▼ ${below} more`)}`;
      }

      lines.push(...headerChrome);
      if (topIndicator !== null) lines.push(topIndicator);
      if (stickyHeader !== null) lines.push(stickyHeader);
      for (const row of visibleRows) {
        if (row.kind === 'separator') {
          lines.push(pc.dim('│'));
        } else if (row.kind === 'header') {
          lines.push(`${pc.dim('│')}  ${pc.underline(row.text)}`);
        } else {
          const item = items[row.itemIdx]!;
          const isFocused = row.displayIdx === cursor;
          lines.push(formatRow(item, levels[row.itemIdx]!, isFocused));
        }
      }
      if (bottomIndicator !== null) lines.push(bottomIndicator);
      lines.push(...footerChrome);

      const output = lines.join('\n') + '\n';
      stdout.write(output);
      renderedLines = lines.length;
    }

    function onResize() {
      render();
    }

    function cleanup() {
      stdin.removeListener('keypress', onKeypress);
      stdout.removeListener('resize', onResize);
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
    stdout.on('resize', onResize);
  });
}

/** Returns the section the focused item is in, plus the row index of its header. */
function getCurrentSection(
  cursor: number,
  changedCount: number,
  unchangedCount: number,
): { headerRowIdx: number; name: string } | null {
  if (cursor < changedCount) {
    if (changedCount === 0) return null;
    return { headerRowIdx: 0, name: 'Changed' };
  }
  if (unchangedCount === 0) return null;
  // Unchanged header is at row 0 if there's no Changed section, otherwise
  // it follows: [Changed header (1)] + [changed items (N)] + [separator (1)]
  return { headerRowIdx: changedCount > 0 ? changedCount + 2 : 0, name: 'Unchanged' };
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
