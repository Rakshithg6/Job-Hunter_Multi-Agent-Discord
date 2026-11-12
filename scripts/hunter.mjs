import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const snapshot = { ...process.env };
try {
  process.loadEnvFile(process.env.ENV_FILE || undefined);
} catch {}
for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;

const USAGE = `Usage:
  node scripts/hunter.mjs domain --domain razorpay.com --out jobs/razorpay/hunter.json
  node scripts/hunter.mjs find --domain razorpay.com --first Rahul --last Sharma
  node scripts/hunter.mjs verify --email rahul.sharma@razorpay.com`;

class UsageError extends Error {}

function warn(message) {
  process.stderr.write(`[hunter] ${message}\n`);
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    let name = arg.slice(2);
    let value;
    const equals = name.indexOf('=');
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    } else if (name === 'domain' || name === 'out' || name === 'first' || name === 'last' || name === 'email') {
      value = rest[++i];
    }
    options[name] = value;
  }
  return { command, options };
}

function describeHunterError(status, body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const detail = errors
    .map(error => [error.id, error.code, error.details].filter(Boolean).join(' '))
    .join('; ')
    .trim();
  const lower = detail.toLowerCase();
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401) return 'authentication failed (401) - check HUNTER_API_KEY';
  if (status === 402 || lower.includes('credit') || lower.includes('quota') || lower.includes('plan') || lower.includes('usage')) {
    return `out of credits or plan limit reached (HTTP ${status})${suffix}`;
  }
  if (status === 429) return `rate limited by Hunter (429) - try again later${suffix}`;
  return `Hunter API error (HTTP ${status})${suffix}`;
}

async function callHunter(endpoint, params, apiKey) {
  const query = new URLSearchParams({ ...params, api_key: apiKey });
  let response;
  try {
    response = await fetch(`https://api.hunter.io/v2/${endpoint}?${query}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`network error calling Hunter ${endpoint}: ${error.message}`);
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!response.ok) throw new Error(describeHunterError(response.status, body));
  if (!body) throw new Error(`Hunter ${endpoint} returned an unreadable response`);
  return body;
}

async function readCached(outPath) {
  try {
    const text = await readFile(outPath, 'utf8');
    const cached = JSON.parse(text);
    warn(`using cached ${outPath} (no API call)`);
    return cached;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    warn(`ignoring unreadable cache ${outPath}: ${error.message}`);
    return null;
  }
}

async function runDomain(options, apiKey) {
  if (!options.domain) throw new UsageError('missing --domain');
  if (options.out) {
    const cached = await readCached(options.out);
    if (cached) return cached;
  }
  const body = await callHunter('domain-search', {
    domain: options.domain,
    department: 'it',
    limit: '10',
  }, apiKey);
  const data = body.data || {};
  const contacts = Array.isArray(data.emails) ? data.emails : Array.isArray(data.people) ? data.people : [];
  const result = {
    organization: data.organization || null,
    pattern: data.pattern || null,
    acceptAll: data.accept_all ?? null,
    people: contacts.map(person => ({
      firstName: person.first_name || null,
      lastName: person.last_name || null,
      position: person.position || null,
      email: person.value || null,
      confidence: person.confidence ?? null,
      linkedin: person.linkedin || null,
    })),
  };
  if (options.out) {
    try {
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch (error) {
      warn(`could not write ${options.out}: ${error.message}`);
    }
  }
  return result;
}

async function runFind(options, apiKey) {
  if (!options.domain) throw new UsageError('missing --domain');
  if (!options.first) throw new UsageError('missing --first');
  if (!options.last) throw new UsageError('missing --last');
  const body = await callHunter('email-finder', {
    domain: options.domain,
    first_name: options.first,
    last_name: options.last,
  }, apiKey);
  const data = body.data || {};
  return { email: data.email || null, score: data.score ?? null };
}

async function runVerify(options, apiKey) {
  if (!options.email) throw new UsageError('missing --email');
  const body = await callHunter('email-verifier', { email: options.email }, apiKey);
  const data = body.data || {};
  return { email: data.email || options.email, status: data.status || null, score: data.score ?? null };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === '--help' || command === '-h') {
    process.stderr.write(`${USAGE}\n`);
    if (!command) process.exitCode = 1;
    return;
  }

  const apiKey = (process.env.HUNTER_API_KEY || '').trim();
  if (!apiKey) {
    process.stdout.write(`${JSON.stringify({ enabled: false })}\n`);
    return;
  }

  let result;
  if (command === 'domain') result = await runDomain(options, apiKey);
  else if (command === 'find') result = await runFind(options, apiKey);
  else if (command === 'verify') result = await runVerify(options, apiKey);
  else throw new UsageError(`unknown command: ${command}`);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  warn(error.message);
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}
