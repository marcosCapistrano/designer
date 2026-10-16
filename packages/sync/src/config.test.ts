import { describe, expect, it } from 'vitest';
import { projectAliases } from './index.js';

const tsconfig = (paths: unknown, extra = '') => `{
  // JSONC: comments and trailing commas are allowed
  "compilerOptions": { ${extra} "paths": ${JSON.stringify(paths)}, },
}`;

describe('tsconfig path aliases', () => {
  it('maps the nearest tsconfig paths to source-relative directories', () => {
    const configs = { 'site/tsconfig.json': tsconfig({ '@/*': ['./src/*'] }), 'tsconfig.json': tsconfig({ '~/*': ['./other/*'] }) };
    expect(projectAliases(configs, 'site/src/app')).toEqual({ ok: true, aliases: { '@/': 'site/src/' } });
    expect(projectAliases(configs, 'web/app')).toEqual({ ok: true, aliases: { '~/': 'other/' } });
    expect(projectAliases({}, 'site/src/app')).toEqual({ ok: true, aliases: {} });
  });

  it('resolves targets against baseUrl', () => {
    expect(projectAliases({ 'site/tsconfig.json': tsconfig({ '@ui/*': ['components/ui/*'], '#lib/*': ['../shared/lib/*'] }, '"baseUrl": "./src",') }, 'site/src/app'))
      .toEqual({ ok: true, aliases: { '@ui/': 'site/src/components/ui/', '#lib/': 'site/shared/lib/' } });
  });

  it('fails explicitly on extends, unsupported path shapes and escaping targets, naming the file and entry', () => {
    const fail = (text: string) => projectAliases({ 'site/tsconfig.json': text }, 'site/src/app');
    expect(fail('{ "extends": "./base.json" }')).toEqual({ ok: false, diagnostic: { file: 'site/tsconfig.json', message: 'Unsupported tsconfig extends ./base.json; declare compilerOptions.paths in site/tsconfig.json itself' } });
    expect(fail(tsconfig({ '@/*': ['./src/*', './gen/*'] }))).toMatchObject({ ok: false, diagnostic: { file: 'site/tsconfig.json', message: expect.stringContaining('Unsupported tsconfig paths entry "@/*"') } });
    expect(fail(tsconfig({ '@/x': ['./src/x'] }))).toMatchObject({ ok: false, diagnostic: { message: expect.stringContaining('"@/x"') } });
    expect(fail(tsconfig({ '*': ['./src/*'] }))).toMatchObject({ ok: false, diagnostic: { message: expect.stringContaining('"*"') } });
    expect(fail(tsconfig({ '@/*': ['../../*'] }))).toMatchObject({ ok: false, diagnostic: { message: expect.stringContaining('"@/*"') } });
    expect(fail('{ "compilerOptions": { "paths": [] } }')).toMatchObject({ ok: false, diagnostic: { file: 'site/tsconfig.json' } });
    expect(fail('{ not json')).toMatchObject({ ok: false, diagnostic: { file: 'site/tsconfig.json', message: expect.stringContaining('Invalid tsconfig') } });
  });
});
