import process from 'node:process';

const USAGE = `Usage:
  node scripts/links.mjs gmail --subject "..." --body "..." [--to a@b.com]

Prints a Gmail compose link with the subject, body, and optional recipient
URL-encoded. Without --to the "To" field is left empty.`;

class UsageError extends Error {}

function warn(message) {
  process.stderr.write(`[links] ${message}\n`);
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
  return options[name];
}

function gmailLink(options) {
  const subject = requireOption(options, 'subject');
  const body = requireOption(options, 'body');
  const to = options.to ?? '';
  const parameters = [
    ['view', 'cm'],
    ['fs', '1'],
    ['to', to],
    ['su', subject],
    ['body', body],
  ];
  return `https://mail.google.com/mail/?${parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stderr.write(`${USAGE}\n`);
    if (!command) process.exitCode = 1;
    return;
  }

  let link;
  if (command === 'gmail') {
    link = gmailLink(options);
  } else {
    throw new UsageError(`unknown link type "${command}"`);
  }

  process.stdout.write(`${link}\n`);
  if (link.length > 2000) {
    warn(`link is ${link.length} characters long (over 2000); Gmail may truncate long compose links`);
  }
}

try {
  main();
} catch (error) {
  warn(error.message);
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}
