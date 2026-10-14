// Tests for the hub's ops files (ops/hub/*, docs/hub-bootstrap.md). They live here because apps/server's ops.test.ts
// belongs to the server lane; they run the real scripts against stub commands, so no secret ever reaches a real tool.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file: string): string => readFileSync(join(repo, file), 'utf8');

const SCRIPTS = ['ops/hub/bootstrap.sh', 'ops/hub/set-secret.sh', 'ops/hub/check-claude.sh'] as const;

// Fake secrets. The base64 form is what the GitHub header carries.
const TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtoken0123456789';
const TOKEN_B64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const AUTHKEY = 'tskey-auth-FAKEkeyFAKEkey-FAKEFAKEFAKEFAKEFAKE';

describe('ops/hub/hub.service', () => {
  it('mounts the hub code read-only', () => {
    expect(read('ops/hub/hub.service').split('\n')).toContain('ReadOnlyPaths=/opt/hub');
  });

  it('keeps the hub data and apps directories writable', () => {
    const unit = read('ops/hub/hub.service');
    // ProtectSystem=full leaves /var alone; a ReadWritePaths or ProtectHome line would need a second look.
    expect(unit).not.toMatch(/^ProtectSystem=(strict)$/m);
    expect(unit).not.toMatch(/^ReadOnlyPaths=.*\/var\/lib\/hub/m);
  });
});

