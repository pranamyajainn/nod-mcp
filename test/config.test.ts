import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_TAG, loadConfig, parseEnvFile } from '../src/config.js';
import { mask } from '../src/format.js';
import { TOKEN } from './mock-nod.js';

const files = (map: Record<string, string>) => (path: string) => {
  if (!(path in map)) throw new Error('ENOENT');
  return map[path]!;
};

describe('safety rule 1: localhost only', () => {
  for (const url of ['http://localhost:4310', 'http://127.0.0.1:4310', 'http://[::1]:4310', 'https://localhost'])
    it(`accepts ${url}`, () => {
      expect(loadConfig({ NOD_URL: url, NOD_TOKEN: TOKEN }).baseUrl.hostname).toBe(new URL(url).hostname);
    });

  for (const url of [
    'http://example.com:4310',
    'http://192.168.1.10:4310',
    'http://0.0.0.0:4310',
    'http://localhost.evil.com',
    'http://127.0.0.2:4310',
    'ftp://localhost',
    'http://user:pw@localhost:4310',
    'http://localhost:4310/api',
  ])
    it(`refuses ${url}`, () => {
      expect(() => loadConfig({ NOD_URL: url, NOD_TOKEN: TOKEN })).toThrow(ConfigError);
    });

  it('refuses a remote NOD_PUBLIC_URL from the env file', () => {
    const read = files({ '/nod/.env': `NOD_AUTH_TOKEN=${TOKEN}\nNOD_PUBLIC_URL=https://nod.example.com\n` });
    expect(() => loadConfig({ NOD_ENV_FILE: '/nod/.env' }, read)).toThrow(/this computer/);
  });

  it('uses a loopback NOD_PUBLIC_URL from the env file when NOD_URL is unset', () => {
    const read = files({ '/nod/.env': `NOD_AUTH_TOKEN=${TOKEN}\nNOD_PUBLIC_URL=http://localhost:5555\n` });
    expect(loadConfig({ NOD_ENV_FILE: '/nod/.env' }, read).baseUrl.origin).toBe('http://localhost:5555');
  });

  it('defaults to http://localhost:4310', () => {
    expect(loadConfig({ NOD_TOKEN: TOKEN }).baseUrl.origin).toBe('http://localhost:4310');
  });
});

describe('safety rule 8: token handling', () => {
  it('prefers NOD_AUTH_TOKEN from NOD_ENV_FILE over NOD_TOKEN', () => {
    const other = 'Z'.repeat(50);
    const read = files({ '/nod/.env': `# comment\nCOMPOSE_PROJECT_NAME=nod-x\nNOD_AUTH_TOKEN="${TOKEN}"\n` });
    expect(loadConfig({ NOD_ENV_FILE: '/nod/.env', NOD_TOKEN: other }, read).token).toBe(TOKEN);
  });

  it('falls back to NOD_TOKEN', () => {
    expect(loadConfig({ NOD_TOKEN: TOKEN }).token).toBe(TOKEN);
  });

  it('accepts the 64-character hex token that setup.sh makes', () => {
    const hex = 'a1'.repeat(32);
    expect(loadConfig({ NOD_TOKEN: hex }).token).toBe(hex);
  });

  it('rejects a badly formatted token without echoing it', () => {
    const bad = 'short-but-secret-value!!';
    try {
      loadConfig({ NOD_TOKEN: bad });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
      expect((error as Error).message).toMatch(/wrong format/);
    }
  });

  it('fails clearly when no token is configured', () => {
    expect(() => loadConfig({})).toThrow(/NOD_ENV_FILE|NOD_TOKEN/);
  });

  it('fails clearly when NOD_ENV_FILE cannot be read', () => {
    expect(() => loadConfig({ NOD_ENV_FILE: '/missing/.env' }, files({}))).toThrow(/Could not read/);
  });

  it('masks the token in any output string once loaded', () => {
    loadConfig({ NOD_TOKEN: TOKEN });
    expect(mask(`Bearer ${TOKEN} and again ${TOKEN}`)).toBe('Bearer [hidden] and again [hidden]');
  });
});

describe('safety rules 6 and 7: tag and send flag', () => {
  it('sending is off by default', () => {
    expect(loadConfig({ NOD_TOKEN: TOKEN }).allowSend).toBe(false);
  });
  it('sending is on only with NOD_MCP_ALLOW_SEND=true', () => {
    expect(loadConfig({ NOD_TOKEN: TOKEN, NOD_MCP_ALLOW_SEND: 'true' }).allowSend).toBe(true);
    expect(() => loadConfig({ NOD_TOKEN: TOKEN, NOD_MCP_ALLOW_SEND: 'yes' })).toThrow(ConfigError);
  });
  it('uses the default tag', () => {
    expect(loadConfig({ NOD_TOKEN: TOKEN }).tag).toBe(DEFAULT_TAG);
  });
  it('refuses an empty tag', () => {
    expect(() => loadConfig({ NOD_TOKEN: TOKEN, NOD_MCP_TAG: '' })).toThrow(/cannot be empty/);
    expect(() => loadConfig({ NOD_TOKEN: TOKEN, NOD_MCP_TAG: '   ' })).toThrow(/cannot be empty/);
  });
  it('adds a space after a custom tag', () => {
    expect(loadConfig({ NOD_TOKEN: TOKEN, NOD_MCP_TAG: '[Claude]' }).tag).toBe('[Claude] ');
  });
});

describe("Nod's generated self-host .env", () => {
  // Same layout setup.sh writes (from .env.example), with fake secrets.
  const generated = [
    '# Nod self-host settings',
    'PORT=4310',
    'NOD_BIND_ADDRESS=127.0.0.1',
    'NOD_PUBLIC_URL=http://localhost:${PORT}',
    'COMPOSE_PROJECT_NAME=nod-0123456789abcdef',
    `NOD_AUTH_TOKEN=${'ab'.repeat(32)}`,
    'NOD_VAULT_KEY=c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI=',
    `NOD_POSTGRES_PASSWORD=${'cd'.repeat(32)}`,
  ].join('\n');

  it('expands ${PORT} in NOD_PUBLIC_URL and uses http://localhost:4310', () => {
    const config = loadConfig({ NOD_ENV_FILE: '/nod/.env' }, files({ '/nod/.env': generated }));
    expect(config.baseUrl.origin).toBe('http://localhost:4310');
    expect(config.token).toBe('ab'.repeat(32));
  });

  it('follows a changed PORT', () => {
    const config = loadConfig({ NOD_ENV_FILE: '/nod/.env' }, files({ '/nod/.env': generated.replace('PORT=4310', 'PORT=4999') }));
    expect(config.baseUrl.origin).toBe('http://localhost:4999');
  });
});

describe('env file parsing', () => {
  it('expands ${NAME}, ${NAME:-default} and $NAME, but not in single quotes', () => {
    expect(parseEnvFile(`A=x\nB=\${A}-\${MISSING:-d}-$A\nC='\${A}'\nD="\${A}"`)).toEqual({ A: 'x', B: 'x-d-x', C: '${A}', D: 'x' });
  });

  it('reads quotes, export and comments', () => {
    expect(parseEnvFile(`export A=1\nB='two words'\nC="x" \nD=val # note\n#E=no`)).toEqual({
      A: '1',
      B: 'two words',
      C: 'x',
      D: 'val',
    });
  });
});
