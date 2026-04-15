import * as p from '@clack/prompts';

export * from '@clack/prompts';
export { p };

/**
 * Unwrap a clack prompt result, exiting cleanly if the user cancelled (Ctrl-C / Esc).
 * Every interactive prompt result must flow through this.
 */
export function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Aborted');
    process.exit(0);
  }
  return value as T;
}
