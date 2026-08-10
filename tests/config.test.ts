import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

describe('runtime configuration', () => {
  it('accepts the shared ishiku setup-secret variable', () => {
    const secret = 'synthetic-ishiku-setup-secret-value-1234';
    expect(loadConfig({ ISHIKU_SETUP_SECRET: secret }).setupSecret).toBe(secret);
  });

  it('retains the legacy Vertiku variable for existing deployments', () => {
    const secret = 'synthetic-vertiku-setup-secret-value-123';
    expect(loadConfig({ VERTIKU_SETUP_SECRET: secret }).setupSecret).toBe(secret);
  });

  it('rejects the published Compose placeholder', () => {
    expect(() => loadConfig({
      ISHIKU_SETUP_SECRET: 'REPLACE-WITH-A-UNIQUE-SECRET-OF-AT-LEAST-32-CHARACTERS'
    })).toThrow('Replace the published setup-secret placeholder');
  });

  it('rejects parallel conversion workers because Vertiku is intentionally serial', () => {
    expect(() => loadConfig({ VERTIKU_MAX_CONCURRENT_JOBS: '2' })).toThrow();
  });

  it('keeps password recovery disabled by default and accepts a case-insensitive Compose toggle', () => {
    expect(loadConfig({}).passwordResetEnabled).toBe(false);
    expect(loadConfig({ VERTIKU_PASSWORD_RESET: 'TRUE' }).passwordResetEnabled).toBe(true);
    expect(() => loadConfig({ VERTIKU_PASSWORD_RESET: 'yes' })).toThrow();
  });
});
