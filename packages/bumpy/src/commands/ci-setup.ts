import pc from 'picocolors';
import { log } from '../utils/logger.ts';
import { p, unwrap } from '../utils/clack.ts';
import { tryRunArgs } from '../utils/shell.ts';
import { detectPackageManager } from '../utils/package-manager.ts';
import type { PackageManager } from '../types.ts';

const PAT_PERMISSIONS = [
  'contents: read & write',
  'pull requests: read & write',
  'metadata: read (selected automatically)',
];

export async function ciSetupCommand(rootDir: string): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' bumpy ci setup ')));

  // Detect repo and package manager context
  const repo = detectRepo(rootDir);
  if (!repo) {
    log.error(
      'Could not detect a GitHub repository.\n' +
        '  This command currently only supports GitHub-hosted repos.\n' +
        '  Make sure you have a GitHub remote (git remote -v).',
    );
    process.exit(1);
  }
  const pm = await detectPackageManager(rootDir);

  p.log.info(`Detected repository: ${pc.cyan(repo)}`);
  p.log.info('');
  p.log.info(
    'To trigger CI checks on the version PR, bumpy needs a token\n' +
      "that bypasses GitHub's default anti-recursion guard.\n" +
      'You can use a fine-grained PAT or a GitHub App installation token.',
  );

  const method = unwrap(
    await p.select({
      message: 'How would you like to authenticate?',
      options: [
        {
          label: 'Fine-grained Personal Access Token (PAT)',
          value: 'pat' as const,
          hint: 'recommended — quick and simple',
        },
        {
          label: 'GitHub App installation token',
          value: 'app' as const,
          hint: 'advanced — not tied to a personal account',
        },
      ],
    }),
  );

  if (method === 'pat') {
    await setupPat(rootDir, repo, pm);
  } else {
    await setupApp(rootDir, repo, pm);
  }
}

// ---- PAT flow ----

async function setupPat(rootDir: string, repo: string, pm: PackageManager): Promise<void> {
  const patUrl = 'https://github.com/settings/personal-access-tokens/new';

  p.log.info('');
  p.note(
    [
      `1. Open: ${pc.cyan(patUrl)}`,
      '',
      `2. Set a name, e.g. ${pc.dim('"bumpy-ci"')}`,
      '',
      `3. Under ${pc.bold('Resource owner')}, select the org or account that owns ${pc.cyan(repo)}`,
      '',
      `4. Set ${pc.bold('Expiration')} — choose a longer duration to avoid frequent rotation`,
      `   (you'll need to regenerate and update the secret when it expires)`,
      '',
      `5. Under ${pc.bold('Repository access')}, select ${pc.bold('"Only select repositories"')}`,
      `   and choose ${pc.cyan(repo)}`,
      '',
      `6. Under ${pc.bold('Permissions → Repository permissions')}, grant:`,
      ...PAT_PERMISSIONS.map((perm) => `   • ${pc.bold(perm)}`),
      '',
      '7. Click "Generate token" and copy the value',
      '',
      pc.dim('Tip: enable branch protection rules on your main branch to prevent'),
      pc.dim('direct pushes — the PAT will only be used to push the version branch.'),
    ].join('\n'),
    'Create a fine-grained PAT',
  );

  // Try to open browser
  const shouldOpen = unwrap(await p.confirm({ message: 'Open the token creation page in your browser?' }));
  if (shouldOpen) {
    openBrowser(patUrl);
  }

  // Prompt for the token
  const token = unwrap(
    await p.text({
      message: 'Paste your token:',
      placeholder: 'github_pat_...',
      validate: (value) => {
        if (!value?.trim()) return 'Token is required';
        if (!value?.startsWith('github_pat_')) return 'Expected a fine-grained PAT (starts with github_pat_)';
      },
    }),
  );

  await storeSecret(rootDir, repo, token, pm);
}

// ---- GitHub App flow ----

async function setupApp(rootDir: string, repo: string, pm: PackageManager): Promise<void> {
  const owner = repo.split('/')[0]!;
  const appUrl = `https://github.com/organizations/${owner}/settings/apps/new`;
  const personalAppUrl = `https://github.com/settings/apps/new`;

  const isOrg = unwrap(await p.confirm({ message: `Is ${pc.cyan(owner)} a GitHub organization?`, initialValue: true }));

  const createUrl = isOrg ? appUrl : personalAppUrl;

  p.log.info('');
  p.note(
    [
      'If you already have a GitHub App, skip to step 2.',
      '',
      pc.bold('Step 1: Create a GitHub App'),
      '',
      `1. Open: ${pc.cyan(createUrl)}`,
      `2. Set the name, e.g. ${pc.dim(`"${owner}-bumpy-ci"`)}`,
      '3. Uncheck "Active" under Webhooks (not needed)',
      '4. Under Permissions → Repository permissions, grant:',
      ...PAT_PERMISSIONS.map((perm) => `   • ${pc.bold(perm)}`),
      '5. Under "Where can this app be installed?" select "Only on this account"',
      '6. Click "Create GitHub App"',
      '7. Note the App ID shown on the settings page',
      '8. Generate a private key and download the .pem file',
      '',
      pc.bold('Step 2: Install the App'),
      '',
      `Install the app on ${pc.cyan(repo)} from the app's "Install App" tab.`,
      '',
      pc.bold('Step 3: Add secrets'),
      '',
      "You'll need to add two repository secrets:",
      `  • ${pc.bold('BUMPY_APP_ID')} — the App ID`,
      `  • ${pc.bold('BUMPY_APP_PRIVATE_KEY')} — contents of the .pem file`,
    ].join('\n'),
    'GitHub App setup',
  );

  const shouldOpen = unwrap(await p.confirm({ message: 'Open the app creation page in your browser?' }));
  if (shouldOpen) {
    openBrowser(createUrl);
  }

  const hasSecrets = unwrap(
    await p.confirm({ message: 'Have you added the BUMPY_APP_ID and BUMPY_APP_PRIVATE_KEY secrets?' }),
  );

  if (hasSecrets) {
    printAppWorkflowSnippet(pm);
  } else {
    p.log.info('You can add them later. Once ready, update your release workflow:');
    printAppWorkflowSnippet(pm);
  }

  p.outro(pc.green('GitHub App setup complete!'));
}

// ---- Shared helpers ----

async function storeSecret(rootDir: string, repo: string, token: string, pm: PackageManager): Promise<void> {
  const hasGh = tryRunArgs(['gh', '--version']);
  if (!hasGh) {
    p.log.warn("`gh` CLI not found — you'll need to add the secret manually.");
    p.note(
      `Go to: https://github.com/${repo}/settings/secrets/actions/new\n` +
        `Name: ${pc.bold('BUMPY_GH_TOKEN')}\nValue: (the token you just created)`,
      'Add repository secret manually',
    );
    printPatWorkflowSnippet(pm);
    p.outro(pc.green('Setup complete!'));
    return;
  }

  // Check if the secret already exists
  const existingSecrets = tryRunArgs(['gh', 'secret', 'list', '--repo', repo], { cwd: rootDir });
  const isReplacing = existingSecrets?.includes('BUMPY_GH_TOKEN') ?? false;

  const spin = p.spinner();
  spin.start(
    isReplacing ? 'Replacing BUMPY_GH_TOKEN repository secret...' : 'Storing BUMPY_GH_TOKEN as a repository secret...',
  );
  try {
    // gh secret set reads from stdin and overwrites if the secret already exists
    tryRunArgs(['gh', 'secret', 'set', 'BUMPY_GH_TOKEN', '--repo', repo], {
      cwd: rootDir,
      input: token,
    } as any);
    spin.stop(isReplacing ? 'Secret replaced!' : 'Secret stored!');
  } catch {
    spin.stop('Failed to store secret');
    p.log.warn('Could not store the secret automatically.');
    p.note(
      `Go to: https://github.com/${repo}/settings/secrets/actions/new\n` +
        `Name: ${pc.bold('BUMPY_GH_TOKEN')}\nValue: (the token you just created)`,
      'Add repository secret manually',
    );
  }

  printPatWorkflowSnippet(pm);
  p.outro(pc.green('Setup complete!'));
}

function printPatWorkflowSnippet(pm: PackageManager): void {
  const runCmd = pmxCommand(pm);
  p.note(
    [
      'In your release workflow, pass the token to bumpy:',
      '',
      pc.dim('# .github/workflows/release.yaml'),
      pc.dim(`- run: ${runCmd} ci release`),
      pc.dim('  env:'),
      pc.green('    BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}'),
    ].join('\n'),
    'Update your workflow',
  );
}

function printAppWorkflowSnippet(pm: PackageManager): void {
  const runCmd = pmxCommand(pm);
  p.note(
    [
      'In your release workflow, generate a token and pass it to bumpy:',
      '',
      pc.dim('# .github/workflows/release.yaml'),
      pc.green('- uses: actions/create-github-app-token@v2'),
      pc.green('  id: app-token'),
      pc.green('  with:'),
      pc.green('    app-id: ${{ secrets.BUMPY_APP_ID }}'),
      pc.green('    private-key: ${{ secrets.BUMPY_APP_PRIVATE_KEY }}'),
      '',
      pc.dim(`- run: ${runCmd} ci release`),
      pc.dim('  env:'),
      pc.green('    BUMPY_GH_TOKEN: ${{ steps.app-token.outputs.token }}'),
    ].join('\n'),
    'Update your workflow',
  );
}

/** Package-manager-appropriate command for running bumpy in CI workflows */
function pmxCommand(pm: PackageManager): string {
  if (pm === 'bun') return 'bunx @varlock/bumpy';
  if (pm === 'pnpm') return 'pnpm exec bumpy';
  if (pm === 'yarn') return 'yarn bumpy';
  return 'npx @varlock/bumpy';
}

function detectRepo(rootDir: string): string | null {
  // Check GitHub Actions env first
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

  // Try to extract from git remote
  const remote = tryRunArgs(['git', 'remote', 'get-url', 'origin'], { cwd: rootDir });
  if (!remote) return null;

  // SSH: git@github.com:owner/repo.git
  const sshMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1]!;

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remote.match(/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1]!;

  return null;
}

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    tryRunArgs([cmd, url]);
  } catch {
    // Silent fail — user can open manually
  }
}
