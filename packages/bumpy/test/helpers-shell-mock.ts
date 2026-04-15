/**
 * Shell mock utilities for testing.
 *
 * Uses the shell module's built-in interceptor to hook into command execution.
 * This intercepts `gh` CLI commands by default while passing through
 * real git/system commands to the actual implementation.
 *
 * Usage:
 *   import { installShellMock, resetMockState, addMockRule } from '../helpers-shell-mock.ts';
 *
 *   beforeEach(() => { resetMockState(); });
 *   afterEach(() => { uninstallShellMock(); });
 *   // Or: install once at top of file, call resetMockState() in beforeEach
 */
import { _setInterceptor } from '../src/utils/shell.ts';

export interface CommandCall {
  command: string;
  args: string[];
  opts?: { cwd?: string; input?: string };
}

export interface MockRule {
  /** Pattern to match against the joined command args (string match or regex) */
  match: string | RegExp;
  /** Response to return (stdout) */
  response?: string;
  /** Error to throw (simulates command failure) */
  error?: string;
}

let calls: CommandCall[] = [];
let rules: MockRule[] = [];

function matchCommand(cmdString: string, rule: MockRule): boolean {
  if (typeof rule.match === 'string') {
    return cmdString.includes(rule.match);
  }
  return rule.match.test(cmdString);
}

function findRule(cmdString: string): MockRule | undefined {
  return rules.find((r) => matchCommand(cmdString, r));
}

/**
 * Install the shell mock interceptor.
 * By default intercepts all `gh` commands. Real git/system commands pass through.
 */
export function installShellMock(opts: { interceptGh?: boolean } = {}) {
  calls = [];
  rules = [];

  const interceptGh = opts.interceptGh ?? true;
  if (interceptGh) {
    rules.push({ match: 'gh --version', response: 'gh version 2.50.0' });
    rules.push({ match: /^gh /, response: '{}' });
  }

  _setInterceptor((args, opts) => {
    const cmdString = args.join(' ');
    calls.push({ command: cmdString, args: [...args], opts });

    const rule = findRule(cmdString);
    if (rule) {
      if (rule.error) return { intercepted: true, error: rule.error };
      return { intercepted: true, result: rule.response ?? '' };
    }

    // Not intercepted — pass through to real implementation
    return { intercepted: false };
  });
}

/** Reset mock state (calls + rules) and re-install with fresh defaults */
export function resetMockState(opts: { interceptGh?: boolean } = {}) {
  installShellMock(opts);
}

/** Uninstall the interceptor entirely */
export function uninstallShellMock() {
  _setInterceptor(null);
  calls = [];
  rules = [];
}

/** Add a custom mock rule (higher priority than defaults) */
export function addMockRule(rule: MockRule) {
  rules.unshift(rule);
}

/** Get all recorded command calls */
export function getCalls(): CommandCall[] {
  return [...calls];
}

/** Get calls matching a pattern */
export function getCallsMatching(pattern: string | RegExp): CommandCall[] {
  return calls.filter((c) => {
    if (typeof pattern === 'string') return c.command.includes(pattern);
    return pattern.test(c.command);
  });
}

/** Clear recorded calls */
export function clearCalls() {
  calls = [];
}
