import { test, expect, describe } from 'bun:test';
import {
  parseReleaseMetadata,
  formatPublishedToSection,
  composeReleaseBody,
  updateReleaseBodyStatus,
  buildPublishUrl,
  type ReleaseMetadata,
} from '../../src/core/github-release.ts';

describe('parseReleaseMetadata', () => {
  test('parses valid metadata from release body', () => {
    const body = `## What's Changed

- Fixed a bug

#### Published to
- ✅ npm

<!-- bumpy-metadata
{
  "version": "1.9.2",
  "targets": {
    "npm": { "status": "success", "publishedAt": "2026-05-25T10:30:00Z" }
  }
}
bumpy-metadata -->`;

    const metadata = parseReleaseMetadata(body);
    expect(metadata).not.toBeNull();
    expect(metadata!.version).toBe('1.9.2');
    expect(metadata!.targets['npm']!.status).toBe('success');
    expect(metadata!.targets['npm']!.publishedAt).toBe('2026-05-25T10:30:00Z');
  });

  test('returns null for body without metadata', () => {
    const body = `## What's Changed\n\n- Fixed a bug`;
    expect(parseReleaseMetadata(body)).toBeNull();
  });

  test('returns null for malformed metadata JSON', () => {
    const body = `<!-- bumpy-metadata\n{invalid json}\nbumpy-metadata -->`;
    expect(parseReleaseMetadata(body)).toBeNull();
  });

  test('parses metadata with multiple targets', () => {
    const body = `<!-- bumpy-metadata
{
  "version": "1.0.0",
  "targets": {
    "npm": { "status": "success", "publishedAt": "2026-05-25T10:00:00Z" },
    "jsr": { "status": "failed", "error": "auth timeout", "lastAttempt": "2026-05-25T10:00:05Z" }
  }
}
bumpy-metadata -->`;

    const metadata = parseReleaseMetadata(body);
    expect(metadata!.targets['npm']!.status).toBe('success');
    expect(metadata!.targets['jsr']!.status).toBe('failed');
    expect(metadata!.targets['jsr']!.error).toBe('auth timeout');
  });
});

describe('formatPublishedToSection', () => {
  test('formats all-success targets with URLs', () => {
    const targets = {
      npm: { status: 'success' as const, url: 'https://www.npmjs.com/package/foo/v/1.0.0' },
      jsr: { status: 'success' as const, url: 'https://jsr.io/@scope/foo@1.0.0' },
    };
    const result = formatPublishedToSection(targets);
    expect(result).toContain('#### Published to');
    expect(result).toContain('- ✅ [npm](https://www.npmjs.com/package/foo/v/1.0.0)');
    expect(result).toContain('- ✅ [jsr](https://jsr.io/@scope/foo@1.0.0)');
  });

  test('formats success without URL', () => {
    const targets = { custom: { status: 'success' as const } };
    const result = formatPublishedToSection(targets);
    expect(result).toContain('- ✅ custom');
  });

  test('formats failed targets', () => {
    const targets = { npm: { status: 'failed' as const, error: 'timeout' } };
    const result = formatPublishedToSection(targets);
    expect(result).toContain('- ❌ npm — will retry on next CI run');
  });

  test('formats skipped/superseded targets', () => {
    const targets = { jsr: { status: 'skipped' as const, supersededBy: '1.9.3' } };
    const result = formatPublishedToSection(targets);
    expect(result).toContain('- ⏭️ jsr — skipped (superseded by 1.9.3)');
  });

  test('formats pending targets', () => {
    const targets = { npm: { status: 'pending' as const } };
    const result = formatPublishedToSection(targets);
    expect(result).toContain('- ⏳ npm');
  });
});

describe('composeReleaseBody', () => {
  test('combines changelog content with status and metadata', () => {
    const metadata: ReleaseMetadata = {
      version: '1.0.0',
      targets: { npm: { status: 'pending' } },
    };
    const body = composeReleaseBody('- Fixed a bug', metadata);
    expect(body).toContain('- Fixed a bug');
    expect(body).toContain('#### Published to');
    expect(body).toContain('- ⏳ npm');
    expect(body).toContain('<!-- bumpy-metadata');
    expect(body).toContain('"version": "1.0.0"');
    expect(body).toContain('bumpy-metadata -->');
  });
});

describe('updateReleaseBodyStatus', () => {
  test('replaces status section while preserving changelog content', () => {
    const existingBody = `## What's Changed

- Fixed a bug
- Added feature

#### Published to
- ⏳ npm

<!-- bumpy-metadata
{
  "version": "1.0.0",
  "targets": {
    "npm": { "status": "pending" }
  }
}
bumpy-metadata -->`;

    const updatedMetadata: ReleaseMetadata = {
      version: '1.0.0',
      targets: {
        npm: {
          status: 'success',
          publishedAt: '2026-05-25T10:00:00Z',
          url: 'https://www.npmjs.com/package/foo/v/1.0.0',
        },
      },
    };

    const result = updateReleaseBodyStatus(existingBody, updatedMetadata);
    // Changelog preserved
    expect(result).toContain("## What's Changed");
    expect(result).toContain('- Fixed a bug');
    expect(result).toContain('- Added feature');
    // Status updated
    expect(result).toContain('- ✅ [npm](https://www.npmjs.com/package/foo/v/1.0.0)');
    expect(result).not.toContain('⏳');
    // Metadata updated
    expect(result).toContain('"status": "success"');
  });

  test('handles body without existing status section', () => {
    const existingBody = '- Fixed a bug';
    const metadata: ReleaseMetadata = {
      version: '1.0.0',
      targets: { npm: { status: 'success' } },
    };
    const result = updateReleaseBodyStatus(existingBody, metadata);
    expect(result).toContain('- Fixed a bug');
    expect(result).toContain('#### Published to');
    expect(result).toContain('- ✅ npm');
  });

  test('preserves manually edited content above status section', () => {
    const existingBody = `## Custom Release Notes

This release includes important security fixes.

> Note: Please upgrade ASAP.

#### Published to
- ❌ npm — will retry on next CI run

<!-- bumpy-metadata
{"version":"1.0.0","targets":{"npm":{"status":"failed"}}}
bumpy-metadata -->`;

    const metadata: ReleaseMetadata = {
      version: '1.0.0',
      targets: { npm: { status: 'success', url: 'https://www.npmjs.com/package/foo/v/1.0.0' } },
    };
    const result = updateReleaseBodyStatus(existingBody, metadata);
    expect(result).toContain('## Custom Release Notes');
    expect(result).toContain('This release includes important security fixes.');
    expect(result).toContain('> Note: Please upgrade ASAP.');
    expect(result).toContain('- ✅ [npm]');
    expect(result).not.toContain('❌');
  });
});

describe('buildPublishUrl', () => {
  test('builds npm URL', () => {
    expect(buildPublishUrl('@varlock/bumpy', '1.9.2', 'npm')).toBe(
      'https://www.npmjs.com/package/@varlock/bumpy/v/1.9.2',
    );
  });

  test('builds npm URL for unscoped package', () => {
    expect(buildPublishUrl('bumpy', '1.0.0', 'npm')).toBe('https://www.npmjs.com/package/bumpy/v/1.0.0');
  });

  test('builds jsr URL for scoped package', () => {
    expect(buildPublishUrl('@varlock/bumpy', '1.9.2', 'jsr')).toBe('https://jsr.io/@varlock/bumpy@1.9.2');
  });

  test('returns undefined for custom target', () => {
    expect(buildPublishUrl('pkg', '1.0.0', 'custom')).toBeUndefined();
  });
});
