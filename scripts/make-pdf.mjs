import process from 'node:process';
import { stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { basename, dirname, extname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const USAGE = `Usage:
  node scripts/make-pdf.mjs jobs/SLUG/resume.html

Renders the HTML file to an A4 PDF next to it (same name, .pdf extension),
with print backgrounds enabled.`;

function fail(message, code = 1) {
  process.stderr.write(`[make-pdf] ${message}\n`);
  process.exitCode = code;
}

function countPdfPages(bytes) {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const pageObjects = raw.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  if (pageObjects?.length) return pageObjects.length;
  const counts = [...raw.matchAll(/\/Count\s+(\d+)/g)].map(match => Number(match[1]));
  if (counts.length) return Math.max(...counts);
  return null;
}

async function render(inputPath) {
  const source = resolve(inputPath);
  let info;
  try {
    info = await stat(source);
  } catch {
    throw new Error(`input file not found: ${source}`);
  }
  if (!info.isFile()) throw new Error(`input is not a file: ${source}`);

  const extension = extname(source);
  const output = join(dirname(source), `${basename(source, extension)}.pdf`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--allow-file-access-from-files', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    await page.goto(pathToFileURL(source).href, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
      preferCSSPageSize: false,
      timeout: 60000,
    });

    await writeFile(output, pdf, { flush: true });
    return { output, pages: countPdfPages(pdf) };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '-h' || args[0] === '--help') {
    process.stderr.write(`${USAGE}\n`);
    if (args.length !== 1) process.exitCode = 1;
    return;
  }

  try {
    const { output, pages } = await render(args[0]);
    console.log(`PDF:   ${output}`);
    console.log(`Pages: ${pages ?? 'unknown'}`);
  } catch (error) {
    const message = String(error?.message || error);
    if (/Could not find Chrome|Failed to launch/i.test(message)) {
      fail(`could not start Chromium (${message}). Install it with: npx puppeteer browsers install chrome`);
    } else {
      fail(message);
    }
  }
}

main();
