import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('primary ZimaOS Compose policy', () => {
  const compose = readFileSync(resolve('compose.yaml'), 'utf8');

  it('uses direct values without interpolation variables', () => {
    expect(compose).not.toContain('${');
    expect(compose.match(/image: ghcr\.io\/maroishiku\/vertiku:latest/g)).toHaveLength(1);
    expect(compose).toContain('ISHIKU_SETUP_SECRET: "REPLACE-WITH-A-UNIQUE-SECRET-OF-AT-LEAST-32-CHARACTERS"');
  });

  it('uses one persistent ZimaOS service and drops startup privileges before running Vertiku', () => {
    expect(compose).not.toContain('vertiku-permissions');
    expect(compose).not.toContain('service_completed_successfully');
    expect(compose).toContain('setpriv --reuid=1000 --regid=1000 --clear-groups');
    expect(compose).toContain('--bounding-set=-all');
    expect(compose).toContain('--no-new-privs ./node_modules/.bin/tsx src/server/index.ts');
  });

  it('declares the fixed ZimaOS port, storage root, and HTTPS icon', () => {
    expect(compose).toContain('published: "8514"');
    expect(compose).toContain('source: /DATA/AppData/i_vertiku/Data');
    expect(compose).toContain(
      'icon: https://cdn.jsdelivr.net/gh/MaroIshiku/vertiku@main/public/vertiku-icon.png',
    );
  });
});
