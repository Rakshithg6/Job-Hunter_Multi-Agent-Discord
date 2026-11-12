import process from 'node:process';

const snapshot = { ...process.env };
try {
  process.loadEnvFile(process.env.ENV_FILE || undefined);
} catch {}
for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;

const USAGE = 'Usage: node scripts/search-jobs.mjs --query "frontend developer" --location "Bengaluru" [--days 14]';
const DETAIL_FIELDS = ['title', 'company', 'location', 'salary', 'postedAt', 'url', 'source', 'companyWebsite', 'description'];
const LEGAL_WORDS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'pvt', 'private', 'corp', 'corporation', 'plc', 'the']);

function warn(message) {
  process.stderr.write(`[search-jobs] ${message}\n`);
}

function parseArgs(args) {
  const options = { days: 14 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    let name = arg.slice(2);
    let value;
    const equals = name.indexOf('=');
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    } else if (name === 'query' || name === 'location' || name === 'days') {
      value = args[++i];
    }
    if (name === 'query') options.query = value;
    else if (name === 'location') options.location = value;
    else if (name === 'days') options.days = Number(value);
  }
  return options;
}

function datePostedBucket(days) {
  if (!Number.isFinite(days) || days <= 1) return 'today';
  if (days <= 3) return '3days';
  if (days <= 7) return 'week';
  return 'month';
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    const detail = data?.message || data?.error || text.slice(0, 200) || `HTTP ${response.status}`;
    const error = new Error(`${response.status} ${String(detail).trim()}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatSalary(job) {
  const min = job.job_min_salary;
  const max = job.job_max_salary;
  if (min == null && max == null) return null;
  const currency = job.job_salary_currency || '';
  const period = String(job.job_salary_period || '').toLowerCase();
  const range = min != null && max != null ? `${min} - ${max}` : `${min ?? max}`;
  return [currency, range, period].filter(Boolean).join(' ').trim() || null;
}

function mapJsearch(job) {
  const fallbackLocation = [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ');
  return {
    title: job.job_title || null,
    company: job.employer_name || null,
    location: job.job_location || fallbackLocation || null,
    remote: job.job_is_remote === true,
    salary: formatSalary(job),
    postedAt: job.job_posted_at_datetime_utc || (job.job_posted_at_timestamp ? new Date(job.job_posted_at_timestamp * 1000).toISOString() : null),
    url: job.job_apply_link || null,
    source: job.job_publisher || null,
    api: 'jsearch',
    companyWebsite: job.employer_website || null,
    description: job.job_description || null,
  };
}

function stripTracking(link) {
  if (!link) return null;
  try {
    const url = new URL(link);
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return link;
  }
}

function mapSerpapi(job) {
  const extensions = job.detected_extensions || {};
  const applyLink = Array.isArray(job.apply_options) && job.apply_options[0] ? job.apply_options[0].link : null;
  const remote = extensions.work_from_home === true || /remote/i.test(extensions.schedule_type || '') ? true : null;
  return {
    title: job.title || null,
    company: job.company_name || null,
    location: job.location || null,
    remote,
    salary: extensions.salary || null,
    postedAt: extensions.posted_at || null,
    url: stripTracking(applyLink),
    source: String(job.via || '').replace(/^via\s+/i, '').trim() || null,
    api: 'serpapi',
    companyWebsite: null,
    description: job.description || null,
  };
}

async function searchJsearch({ query, location, days }) {
  const key = (process.env.JSEARCH_RAPIDAPI_KEY || '').trim();
  if (!key) throw new Error('JSEARCH_RAPIDAPI_KEY is not set');

  const jobs = [];
  let cursor = null;
  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({
      query: `${query} in ${location}`,
      country: 'in',
      date_posted: datePostedBucket(days),
      num_pages: '1',
    });
    if (cursor) params.set('cursor', cursor);
    const data = await requestJson(`https://jsearch.p.rapidapi.com/search-v2?${params}`, {
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    });
    const pageJobs = Array.isArray(data?.data?.jobs) ? data.data.jobs : [];
    jobs.push(...pageJobs);
    const nextCursor = data?.data?.cursor;
    if (!nextCursor || pageJobs.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return jobs.map(mapJsearch);
}

async function searchSerpapi({ query, location }) {
  const key = (process.env.SERPAPI_KEY || '').trim();
  if (!key) throw new Error('SERPAPI_KEY is not set');

  const place = /india/i.test(location) ? location : `${location}, India`;
  const jobs = [];
  let nextPageToken = null;
  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({
      engine: 'google_jobs',
      q: query,
      location: place,
      gl: 'in',
      hl: 'en',
      api_key: key,
    });
    if (nextPageToken) params.set('next_page_token', nextPageToken);
    const data = await requestJson(`https://serpapi.com/search.json?${params}`);
    if (data?.error) throw new Error(data.error);
    const pageJobs = Array.isArray(data?.jobs_results) ? data.jobs_results : [];
    jobs.push(...pageJobs);
    nextPageToken = data?.serpapi_pagination?.next_page_token || null;
    if (!nextPageToken || pageJobs.length === 0) break;
  }
  return jobs.map(mapSerpapi);
}

function normalizeCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word && !LEGAL_WORDS.has(word))
    .join('');
}

function titleTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function similarTitle(a, b) {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  if (!tokensA.length || !tokensB.length) return false;
  const normalizedA = tokensA.join(' ');
  const normalizedB = tokensB.join(' ');
  if (normalizedA === normalizedB) return true;
  const setB = new Set(tokensB);
  const overlap = tokensA.filter(token => setB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  if (overlap / union >= 0.75) return true;
  const ratio = Math.min(normalizedA.length, normalizedB.length) / Math.max(normalizedA.length, normalizedB.length);
  return (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) && ratio >= 0.6;
}

function detailScore(job) {
  let score = 0;
  for (const field of DETAIL_FIELDS) if (job[field]) score += 1;
  score += Math.min(String(job.description || '').length / 2000, 2);
  return score;
}

function mergeJobs(items) {
  const merged = [];
  let duplicates = 0;
  for (const item of items) {
    const index = merged.findIndex(existing =>
      normalizeCompany(existing.company) === normalizeCompany(item.company) &&
      similarTitle(existing.title, item.title));
    if (index === -1) {
      merged.push({ ...item });
      continue;
    }
    duplicates += 1;
    const existing = merged[index];
    const keeper = detailScore(item) > detailScore(existing) ? item : existing;
    const other = keeper === item ? existing : item;
    const combined = { ...other, ...keeper };
    for (const field of DETAIL_FIELDS) {
      if (!combined[field] && other[field]) combined[field] = other[field];
    }
    if (combined.remote == null && other.remote != null) combined.remote = other.remote;
    combined.api = existing.api === item.api ? existing.api : 'both';
    merged[index] = combined;
  }
  return { merged, duplicates };
}

async function attempt(label, run) {
  try {
    const items = await run();
    return { items };
  } catch (error) {
    warn(`${label} failed: ${error.message}`);
    return { items: [] };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.query) {
    warn('missing --query');
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const location = String(options.location || 'India').trim() || 'India';

  const [jsearch, serpapi] = await Promise.all([
    attempt('jsearch', () => searchJsearch({ ...options, location })),
    attempt('serpapi', () => searchSerpapi({ ...options, location })),
  ]);

  const { merged, duplicates } = mergeJobs([...jsearch.items, ...serpapi.items]);
  if (!jsearch.items.length && !serpapi.items.length) {
    warn('no results: both APIs failed or returned nothing');
  }
  warn(`results jsearch=${jsearch.items.length} serpapi=${serpapi.items.length} duplicates=${duplicates} total=${merged.length}`);
  process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
}

await main();
