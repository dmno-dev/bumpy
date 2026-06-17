import { test, expect, describe } from 'bun:test';
import { runStreaming, runAsync, runArgsAsync } from '../../src/utils/shell.ts';

describe('runStreaming', () => {
  test('resolves for a successful command', async () => {
    await expect(runStreaming('true')).resolves.toBeUndefined();
  });

  test('surfaces output written to stdout (not stderr) when a command fails', async () => {
    // The command writes its real error to stdout, then exits non-zero — this is
    // exactly the vsce failure mode that used to be swallowed.
    const cmd = `node -e "console.log('REAL_ERROR_ON_STDOUT'); process.exit(1)"`;
    await expect(runStreaming(cmd)).rejects.toThrow(/REAL_ERROR_ON_STDOUT/);
  });

  test('surfaces output written to stderr when a command fails', async () => {
    const cmd = `node -e "console.error('REAL_ERROR_ON_STDERR'); process.exit(1)"`;
    await expect(runStreaming(cmd)).rejects.toThrow(/REAL_ERROR_ON_STDERR/);
  });

  test('includes the exit code and command in the error', async () => {
    await expect(runStreaming('exit 3')).rejects.toThrow(/exit code 3/);
  });
});

describe('runAsync error reporting', () => {
  test('includes stdout in the thrown error when a command writes its error there', async () => {
    const cmd = `node -e "console.log('STDOUT_FAILURE_REASON'); process.exit(1)"`;
    await expect(runAsync(cmd)).rejects.toThrow(/STDOUT_FAILURE_REASON/);
  });
});

describe('runArgsAsync error reporting', () => {
  test('includes stdout in the thrown error when a command writes its error there', async () => {
    await expect(runArgsAsync(['node', '-e', "console.log('ARGS_STDOUT_FAILURE'); process.exit(1)"])).rejects.toThrow(
      /ARGS_STDOUT_FAILURE/,
    );
  });
});
