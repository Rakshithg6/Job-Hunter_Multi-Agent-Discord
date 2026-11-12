# job-hunter

A small Node.js CLI toolkit for running a job search with AI agents: find postings, verify they are still live, look up company contacts, tailor a resume to HTML, render it to PDF, and track every outreach in one place.

No framework, no build step — just `node scripts/*.mjs`.

## Requirements

- Node.js 20.6+ (`process.loadEnvFile` is used to read `.env`)
- A Chromium download via Puppeteer, needed only for PDF rendering

```bash
npm install
```

## Setup

Copy the example env file and fill in the keys for the services you want to use:

```bash
cp .env.example .env
```

| Variable | Used by | Purpose |
| --- | --- | --- |
| `JSEARCH_RAPIDAPI_KEY` | `search-jobs.mjs` | Primary job search (JSearch on RapidAPI) |
| `SERPAPI_KEY` | `search-jobs.mjs` | Fallback job search |
| `HUNTER_API_KEY` | `hunter.mjs` | Company domain and contact lookup |

All three are optional. Scripts fail with a clear message only when the feature you asked for needs a missing key.

## Running the agents with Switch Console

The scripts are driven by AI agents. To set them up and run them, install **Switch Console** — the desktop app for configuring Switch and running agents from:

- **Download:** [latest Switch Console release](https://github.com/sandbox-quantum/switch/releases/latest)
- **Install guide:** [Install Switch Console](https://docs.switchagents.ai/switch-rooms/getting-started/install-switch-console)

Pick the build for your platform: `.dmg` for macOS, `.exe` or `.msi` for Windows, and `.deb`, `.rpm`, or `.AppImage` for Linux. The Windows and Linux builds are currently early access.

## Scripts

### `search-jobs.mjs`

Search job boards and print normalized results.

```bash
node scripts/search-jobs.mjs --query "frontend developer" --location "Bengaluru" --days 14
```

### `check-posting.mjs`

Check whether a posting is still live, by URL or by company + title. Supports Greenhouse, Lever, and Ashby boards.

```bash
node scripts/check-posting.mjs --url "https://jobs.lever.co/acme/1234"
node scripts/check-posting.mjs --company "Acme" --title "Frontend Engineer"
```

### `hunter.mjs`

Look up a company's email pattern, find a person, or verify an address.

```bash
node scripts/hunter.mjs domain --domain acme.com --out jobs/acme/hunter.json
node scripts/hunter.mjs find --domain acme.com --first Rahul --last Sharma
node scripts/hunter.mjs verify --email rahul.sharma@acme.com
```

### `make-pdf.mjs`

Render a resume HTML file to an A4 PDF placed next to it, with print backgrounds enabled.

```bash
node scripts/make-pdf.mjs jobs/acme/resume.html
```

### `links.mjs`

Build URL-encoded Gmail compose links for outreach drafts.

```bash
node scripts/links.mjs gmail --subject "Application: Frontend Engineer" --body "..." --to recruiter@acme.com
```

### `tracker.mjs`

Track outreach per job in `tracker.json` at the repo root.

```bash
node scripts/tracker.mjs add --job acme --person "Rahul Sharma" --channel email --to rahul@acme.com
node scripts/tracker.mjs mark --id <id> --status sent
node scripts/tracker.mjs followed-up --id <id>
node scripts/tracker.mjs due --days 7
node scripts/tracker.mjs list --job acme
node scripts/tracker.mjs job-status --job acme --set applied
node scripts/tracker.mjs jobs
```

## How the workspace is organized

```
scripts/          the CLI tools above
scripts/resume-template.html   starter template for tailoring resumes
jobs/<slug>/      per-application folder: job.md, research.md, people.json,
                  hunter.json, resume.html, resume.pdf
tracker.json      all outreach and application status
```

`jobs/` and `tracker.json` hold personal data (resumes, contact details, recruiter outreach) and are gitignored by design. Only the tooling is tracked in this repository.
