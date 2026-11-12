import process from 'node:process';

const snapshot = { ...process.env };
try {
  process.loadEnvFile(process.env.ENV_FILE || undefined);
} catch {}
for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;

const USAGE = `Usage:
  node scripts/check-posting.mjs --url "https://jobs.lever.co/acme/1234"
  node scripts/check-posting.mjs --company "Razorpay" --title "Frontend Engineer"`;

const BOARDS = ['greenhouse', 'lever', 'ashby'];
const COMPANY_NOISE = new Set(['inc', 'llc', 'ltd', 'limited', 'pvt', 'private', 'corp', 'corporation', 'the', 'technologies', 'technology', 'solutions', 'software', 'systems', 'labs', 'india', 'global', 'group']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...' };

function warn(message) {
  process.stderr.write(`[check-posting] ${message}\n`);
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    let name = arg.slice(2);
    let value;
    const equals = name.indexOf('=');
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    } else if (name === 'url' || name === 'company' || name === 'title') {
      value = args[++i];
    }
    if (name === 'url') options.url = value;
    else if (name === 'company') options.company = value;
    else if (name === 'title') options.title = value;
  }
  return options;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'job-hunter-check-posting/0.1' },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    const detail = data?.error || data?.message || `HTTP ${response.status}`;
    const error = new Error(String(detail).trim() || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function stripHtml(value) {
  if (!value) return null;
  let text = String(value);
  for (let pass = 0; pass < 2 && /&(?:#x?[0-9a-fA-F]+|[a-zA-Z]+);/.test(text); pass++) {
    text = decodeEntities(text);
  }
  text = text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

async function fetchBoard(board, slug) {
  if (board === 'greenhouse') {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    return {
      board,
      company: slug,
      jobs: jobs.map(job => ({
        id: String(job.id),
        title: job.title || null,
        location: job.location?.name || null,
        url: job.absolute_url || null,
        description: stripHtml(job.content),
      })),
    };
  }
  if (board === 'lever') {
    const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    if (data && data.ok === false) throw new Error(data.error || 'board not found');
    const postings = Array.isArray(data) ? data : [];
    return {
      board,
      company: slug,
      jobs: postings.map(job => ({
        id: String(job.id),
        title: job.text || null,
        location: job.categories?.location || (Array.isArray(job.categories?.allLocations) ? job.categories.allLocations.join(', ') : null),
        url: job.hostedUrl || null,
        description: job.descriptionPlain || stripHtml(job.description),
      })),
    };
  }
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
  const jobs = Array.isArray(data?.jobs) ? data.jobs.filter(job => job.isListed !== false) : [];
  return {
    board,
    company: slug,
    jobs: jobs.map(job => ({
      id: String(job.id),
      title: job.title || null,
      location: job.location || null,
      url: job.jobUrl || null,
      description: job.descriptionPlainText || stripHtml(job.descriptionHtml),
    })),
  };
}

function parseJobUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (segments.length >= 3 && segments[1] === 'jobs') {
      return { board: 'greenhouse', slug: segments[0], id: segments[2] };
    }
  } else if (host === 'jobs.lever.co' && segments.length >= 2) {
    return { board: 'lever', slug: segments[0], id: segments[1] };
  } else if (host === 'jobs.ashbyhq.com' && segments.length >= 2) {
    return { board: 'ashby', slug: segments[0], id: segments[1] };
  }
  throw new Error(`unsupported job URL host or path: ${host}${url.pathname}`);
}

function slugCandidates(name) {
  const words = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const full = words.join('-');
  const stripped = words.filter(word => !COMPANY_NOISE.has(word)).join('-') || full;
  const candidates = new Set([full, full.replace(/-/g, ''), stripped, stripped.replace(/-/g, '')]);
  return [...candidates].filter(Boolean).slice(0, 4);
}

function titleScore(left, right) {
  const tokensLeft = String(left || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const tokensRight = String(right || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokensLeft.length || !tokensRight.length) return 0;
  const normalizedLeft = tokensLeft.join(' ');
  const normalizedRight = tokensRight.join(' ');
  if (normalizedLeft === normalizedRight) return 1;
  const setRight = new Set(tokensRight);
  const overlap = tokensLeft.filter(token => setRight.has(token)).length;
  const union = new Set([...tokensLeft, ...tokensRight]).size;
  let score = union ? overlap / union : 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    score = Math.max(score, 0.9);
  }
  return score;
}

async function findByCompany(company, title) {
  let best = null;
  let sawBoard = false;
  for (const slug of slugCandidates(company)) {
    const results = await Promise.allSettled(BOARDS.map(board => fetchBoard(board, slug)));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      sawBoard = true;
      for (const job of result.value.jobs) {
        const score = titleScore(job.title, title);
        if (!best || score > best.score) {
          best = { score, board: result.value.board, company: result.value.company, job };
        }
      }
    }
    if (best && best.score >= 0.95) break;
  }
  if (!best || best.score < 0.6) return { found: false, sawBoard, best };
  return { found: true, sawBoard, best };
}

function resultFromJob(board, company, job) {
  return {
    found: true,
    board,
    url: job.url || null,
    title: job.title || null,
    company: company || null,
    location: job.location || null,
    description: job.description || null,
  };
}

function notFound(board, company, url) {
  return {
    found: false,
    board: board || null,
    url: url || null,
    title: null,
    company: company || null,
    location: null,
    description: null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let result;

  if (options.url) {
    const target = parseJobUrl(options.url);
    const board = await fetchBoard(target.board, target.slug);
    const job = board.jobs.find(item => item.id === target.id);
    if (job) {
      result = resultFromJob(board.board, target.slug, job);
    } else {
      warn(`posting ${target.id} is not open on the ${board.board} board for ${target.slug}`);
      result = notFound(board.board, target.slug, options.url);
    }
  } else if (options.company) {
    if (!options.title) {
      warn('missing --title (required with --company)');
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    const { found, sawBoard, best } = await findByCompany(options.company, options.title);
    if (found) {
      result = resultFromJob(best.board, best.company, best.job);
    } else {
      warn(sawBoard
        ? `no open job close to "${options.title}" for ${options.company}`
        : `no public Greenhouse, Lever, or Ashby board responded for ${options.company}`);
      result = notFound(best?.board, options.company, null);
    }
  } else {
    warn('missing --url or --company');
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  warn(error.message);
  process.exitCode = 1;
}
