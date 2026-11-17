// Reads and checks the environment. Any problem stops the server at startup.
import { readFileSync } from 'node:fs';
import { registerSecret } from './format.js';

export interface Config {
  /** Origin of the Nod server, always a loopback host. */
  baseUrl: URL;
  token: string;
  allowSend: boolean;
  /** Prefix put at the start of every outgoing message. Never empty. */
  tag: string;
  maxText: number;
}

export class ConfigError extends Error {}

export const DEFAULT_URL = 'http://localhost:4310';
export const DEFAULT_TAG = '[via Claude] ';
export const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43,}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

/**
 * Minimal .env reader: KEY=VALUE lines, optional `export`, optional quotes, # comments.
 * Like Docker Compose, unquoted and double-quoted values expand ${NAME}, ${NAME:-default}
 * and $NAME from keys earlier in the same file. Nod's self-host .env uses this:
 * NOD_PUBLIC_URL=http://localhost:${PORT}
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const expand = (value: string) =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, fallback, bare) => {
      const name = (braced ?? bare) as string;
      const found = out[name];
      return found !== undefined && found !== '' ? found : ((fallback as string | undefined) ?? '');
    });
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if (quote === "'" && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (quote === '"' && value.endsWith(quote) && value.length >= 2) {
      value = expand(value.slice(1, -1));
    } else {
      value = expand(value.replace(/\s+#.*$/, ''));
    }
    out[match[1]!] = value;
  }
  return out;
}

/** Accept only an http(s) origin on a loopback host. */
export function checkLoopbackUrl(value: string, source: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${source} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ConfigError(`${source} must use http or https.`);
  if (!LOOPBACK.has(url.hostname))
    throw new ConfigError(
      `${source} must point to this computer (localhost, 127.0.0.1 or [::1]). Remote Nod servers are not supported.`,
    );
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new ConfigError(`${source} must be an origin only, like ${DEFAULT_URL}.`);
  return new URL(url.origin);
}

export function loadConfig(env: Env = process.env, readFile: ReadFile = (p) => readFileSync(p, 'utf8')): Config {
  let fileEnv: Record<string, string> = {};
  if (env.NOD_ENV_FILE) {
    let content: string;
    try {
      content = readFile(env.NOD_ENV_FILE);
    } catch {
      throw new ConfigError(`Could not read NOD_ENV_FILE (${env.NOD_ENV_FILE}).`);
    }
    fileEnv = parseEnvFile(content);
  }

  // Token: Nod's own .env first, so no second copy of the secret exists.
  const fromFile = fileEnv.NOD_AUTH_TOKEN;
  const token = fromFile || env.NOD_TOKEN;
  registerSecret(token);
  if (!token)
    throw new ConfigError(
      env.NOD_ENV_FILE
        ? 'NOD_ENV_FILE has no NOD_AUTH_TOKEN, and NOD_TOKEN is not set.'
        : 'Set NOD_ENV_FILE to Nod\'s .env file (preferred) or set NOD_TOKEN.',
    );
  if (!TOKEN_FORMAT.test(token))
    throw new ConfigError(
      `The Nod token from ${fromFile ? 'NOD_ENV_FILE' : 'NOD_TOKEN'} has the wrong format. It must be at least 43 letters, digits, "_" or "-".`,
    );

  // Base URL: NOD_URL, else a loopback NOD_PUBLIC_URL from Nod's .env, else the default.
  let baseUrl: URL;
  if (env.NOD_URL) baseUrl = checkLoopbackUrl(env.NOD_URL, 'NOD_URL');
  else if (fileEnv.NOD_PUBLIC_URL) baseUrl = checkLoopbackUrl(fileEnv.NOD_PUBLIC_URL, 'NOD_PUBLIC_URL in NOD_ENV_FILE');
  else baseUrl = new URL(DEFAULT_URL);

  const sendFlag = (env.NOD_MCP_ALLOW_SEND ?? 'false').trim().toLowerCase();
  if (sendFlag !== 'true' && sendFlag !== 'false')
    throw new ConfigError('NOD_MCP_ALLOW_SEND must be "true" or "false".');

  let tag = DEFAULT_TAG;
  if (env.NOD_MCP_TAG !== undefined) {
    if (!env.NOD_MCP_TAG.trim()) throw new ConfigError('NOD_MCP_TAG cannot be empty. Remove it to use the default.');
    tag = /\s$/.test(env.NOD_MCP_TAG) ? env.NOD_MCP_TAG : `${env.NOD_MCP_TAG} `;
    if (tag.length > 100) throw new ConfigError('NOD_MCP_TAG must be 100 characters or fewer.');
  }

  let maxText = 4000;
  if (env.NOD_MCP_MAX_TEXT !== undefined) {
    maxText = Number(env.NOD_MCP_MAX_TEXT);
    if (!Number.isInteger(maxText) || maxText < 200 || maxText > 100_000)
      throw new ConfigError('NOD_MCP_MAX_TEXT must be a whole number from 200 to 100000.');
  }

  return { baseUrl, token, allowSend: sendFlag === 'true', tag, maxText };
}
