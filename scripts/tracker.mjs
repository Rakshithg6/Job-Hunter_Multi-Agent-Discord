import process from 'node:process';
import { randomInt } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  node scripts/tracker.mjs add --job SLUG --person "Name" --channel email|linkedin [--to ADDRESS_OR_URL]
  node scripts/tracker.mjs mark --id ID --status sent|replied
  node scripts/tracker.mjs due [--job SLUG] [--days N]
  node scripts/tracker.mjs followed-up --id ID
  node scripts/tracker.mjs list --job SLUG
  node scripts/tracker.mjs job-status --job SLUG --set applied|interviewing|rejected|offer
  node scripts/tracker.mjs jobs

Reads and writes tracker.json at the repository root.`;

const TRACKER_PATH = process.env.TRACKER_FILE
  ? resolve(process.env.TRACKER_FILE)
  : fileURLToPath(new URL('../tracker.json', import.meta.url));

const CHANNELS = ['email', 'linkedin'];
const STATUSES = ['sent', 'replied'];
const JOB_STATUSES = ['applied', 'interviewing', 'rejected', 'offer'];
const CLOSED_JOB_STATUSES = new Set(['interviewing', 'rejected', 'offer']);
const MAX_FOLLOW_UPS = 2;
const DEFAULT_DUE_DAYS = 5;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

class UsageError extends Error {}

function warn(message) {
  process.stderr.write(`[tracker] ${message}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
    } else {
      if (rest[i + 1] === undefined) throw new UsageError(`missing value for --${name}`);
      value = rest[++i];
    }
    options[name] = value;
  }
  return { command, options };
}

function requireOption(options, name) {
  if (options[name] === undefined) throw new UsageError(`missing --${name}`);
  return String(options[name]).trim();
}

function requiredText(options, name) {
  const value = requireOption(options, name);
  if (!value) throw new UsageError(`--${name} cannot be empty`);
  return value;
}

function oneOf(options, name, values) {
  const value = requireOption(options, name).toLowerCase();
  if (!values.includes(value)) throw new UsageError(`--${name} must be one of: ${values.join(', ')}`);
  return value;
}

async function loadTracker() {
  let text;
  try {
    text = await readFile(TRACKER_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], jobs: {} };
    throw error;
  }
  if (!text.trim()) return { entries: [], jobs: {} };

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`not valid JSON: ${TRACKER_PATH}`);
  }

  // Older tracker.json files held a bare entries array.
  if (Array.isArray(data)) return { entries: data, jobs: {} };
  if (!data || typeof data !== 'object') throw new Error(`expected an object or array in ${TRACKER_PATH}`);

  const entries = data.entries ?? [];
  if (!Array.isArray(entries)) throw new Error(`expected "entries" to be an array in ${TRACKER_PATH}`);
  const jobs = data.jobs ?? {};
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    throw new Error(`expected "jobs" to be an object in ${TRACKER_PATH}`);
  }
  return { entries, jobs };
}

async function saveTracker({ entries, jobs }) {
  const text = `${JSON.stringify({ entries, jobs }, null, 2)}\n`;
  const temporary = `${TRACKER_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, text, 'utf8');
  try {
    await rename(temporary, TRACKER_PATH);
  } catch {
    await unlink(temporary).catch(() => {});
    await writeFile(TRACKER_PATH, text, 'utf8');
  }
}

function createId(entries) {
  const taken = new Set(entries.map(entry => entry.id));
  for (let attempt = 0; attempt < 100; attempt++) {
    let id = '';
    for (let index = 0; index < ID_LENGTH; index++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
  throw new Error('could not generate a unique entry id');
}

function findEntry(entries, id) {
  const entry = entries.find(item => item.id === id);
  if (!entry) throw new Error(`no entry with id "${id}"`);
  return entry;
}

async function addEntry(options) {
  const job = requiredText(options, 'job');
  const person = requiredText(options, 'person');
  const channel = oneOf(options, 'channel', CHANNELS);
  const to = options.to === undefined ? '' : String(options.to).trim();

  const store = await loadTracker();
  const entry = { id: createId(store.entries), job, person, channel };
  if (to) entry.to = to;
  Object.assign(entry, {
    status: 'drafted',
    followUps: 0,
    createdAt: new Date().toISOString(),
    sentAt: null,
  });

  store.entries.push(entry);
  await saveTracker(store);
  process.stdout.write(`${entry.id}\n`);
}

async function markEntry(options) {
  const id = requiredText(options, 'id');
  const status = oneOf(options, 'status', STATUSES);

  const store = await loadTracker();
  const entry = findEntry(store.entries, id);
  entry.status = status;
  if (status === 'sent') entry.sentAt = new Date().toISOString();

  await saveTracker(store);
  printJson(entry);
}

async function listDue(options) {
  const raw = options.days === undefined ? String(DEFAULT_DUE_DAYS) : requireOption(options, 'days');
  const days = Number(raw);
  if (raw === '' || !Number.isFinite(days) || days < 0) {
    throw new UsageError('--days must be a non-negative number');
  }
  const jobFilter = options.job === undefined ? null : requiredText(options, 'job');

  const { entries, jobs } = await loadTracker();
  const now = Date.now();
  const threshold = days * DAY_MS;
  const due = [];

  for (const entry of entries) {
    if (jobFilter && entry.job !== jobFilter) continue;
    if (CLOSED_JOB_STATUSES.has(jobs[entry.job])) continue;
    if (entry.channel !== 'email') continue;
    if (entry.status !== 'sent') continue;
    if ((entry.followUps ?? 0) >= MAX_FOLLOW_UPS) continue;
    const sentAt = Date.parse(entry.sentAt);
    if (!Number.isFinite(sentAt)) {
      if (entry.sentAt) warn(`skipping ${entry.id}: unreadable sentAt "${entry.sentAt}"`);
      continue;
    }
    if (now - sentAt < threshold) continue;
    due.push(entry);
  }

  due.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  if (!due.length) {
    const scope = jobFilter ? ` for job "${jobFilter}"` : '';
    warn(`no follow-ups due${scope} (email, status sent, sentAt at least ${days} day${days === 1 ? '' : 's'} ago, followUps under ${MAX_FOLLOW_UPS})`);
  }
  printJson(due);
}

async function followUpEntry(options) {
  const id = requiredText(options, 'id');

  const store = await loadTracker();
  const entry = findEntry(store.entries, id);
  entry.followUps = (entry.followUps ?? 0) + 1;
  entry.sentAt = new Date().toISOString();
  if (entry.status !== 'sent') {
    warn(`${entry.id} has status "${entry.status}"; only sent entries show up in due`);
  }

  await saveTracker(store);
  printJson(entry);
}

async function listEntries(options) {
  const job = requiredText(options, 'job');

  const { entries } = await loadTracker();
  printJson(entries.filter(entry => entry.job === job));
}

async function setJobStatus(options) {
  const job = requiredText(options, 'job');
  const status = oneOf(options, 'set', JOB_STATUSES);

  const store = await loadTracker();
  store.jobs[job] = status;
  await saveTracker(store);
  printJson({ job, status });
}

async function listJobs() {
  const { entries, jobs } = await loadTracker();
  const slugs = new Set([...Object.keys(jobs), ...entries.map(entry => entry.job)]);

  const rows = [...slugs].sort().map(job => {
    const forJob = entries.filter(entry => entry.job === job);
    const count = status => forJob.filter(entry => entry.status === status).length;
    return {
      job,
      status: jobs[job] ?? 'unset',
      drafted: count('drafted'),
      sent: count('sent'),
      replied: count('replied'),
    };
  });

  printJson(rows);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stderr.write(`${USAGE}\n`);
      if (!command) process.exitCode = 1;
      return;
    case 'add':
      await addEntry(options);
      return;
    case 'mark':
      await markEntry(options);
      return;
    case 'due':
      await listDue(options);
      return;
    case 'followed-up':
      await followUpEntry(options);
      return;
    case 'list':
      await listEntries(options);
      return;
    case 'job-status':
      await setJobStatus(options);
      return;
    case 'jobs':
      await listJobs();
      return;
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

try {
  await main();
} catch (error) {
  warn(error.message);
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}
