/**
 * Test preload (see bunfig.toml): make git hermetic. Tests create real repos and
 * commits, which must not depend on the developer's global git config — commit
 * signing (a 1Password/gpg agent prompt would hang or fail), hooks, default branch,
 * identity. Global/system config is disabled and an identity is provided via env.
 */
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME ??= 'bumpy-test';
process.env.GIT_AUTHOR_EMAIL ??= 'bumpy-test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'bumpy-test';
process.env.GIT_COMMITTER_EMAIL ??= 'bumpy-test@example.com';
