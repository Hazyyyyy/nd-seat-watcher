// Zero-cost Notre Dame PATH seat watcher.
//
// Reads public class search results at https://classsearch.nd.edu/ for a list
// of CRNs and reports whether each one *looks* open. This script never logs
// into anything, never stores credentials, and never registers for anything.
// It only reads a public page and fails the process (non-zero exit code) so
// a GitHub Action run shows red when a seat may have opened up.
//
// Because classsearch.nd.edu is a client-rendered app whose markup can change,
// detection here is heuristic (text-based), not tied to specific DOM ids. When
// a result can't be confidently classified, it is reported as "unknown" rather
// than silently assumed open or closed, and debug artifacts are written so the
// heuristics can be tuned.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SITE_URL = 'https://classsearch.nd.edu/';
const DEBUG_DIR = path.join(__dirname, 'debug');

const TERM = process.env.ND_TERM && process.env.ND_TERM.trim()
  ? process.env.ND_TERM.trim()
  : 'Fall Semester 2026';

const CRNS = (process.env.ND_CRNS || '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

function ensureDebugDir() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

async function saveDebugArtifacts(page, label) {
  try {
    ensureDebugDir();
    const safe = label.replace(/[^a-z0-9_-]/gi, '_');
    await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}.png`), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => null);
    if (html) fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), html);
  } catch {
    // Debug artifacts are best-effort only; never let them break the run.
  }
}

// Try a native <select> first, then fall back to a custom dropdown widget
// (click to open, click the matching option text).
async function selectTerm(page, term) {
  const selects = page.locator('select');
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i++) {
    const sel = selects.nth(i);
    const optionTexts = await sel.locator('option').allTextContents().catch(() => []);
    if (optionTexts.some((t) => t.trim() === term)) {
      await sel.selectOption({ label: term });
      return true;
    }
  }

  const comboCandidates = page.getByRole('combobox');
  const comboCount = await comboCandidates.count().catch(() => 0);
  for (let i = 0; i < comboCount; i++) {
    const el = comboCandidates.nth(i);
    try {
      await el.click({ timeout: 3000 });
      const option = page.getByText(term, { exact: true });
      if (await option.count()) {
        await option.first().click({ timeout: 3000 });
        return true;
      }
      await page.keyboard.press('Escape');
    } catch {
      // Try the next combobox candidate.
    }
  }
  return false;
}

async function fillKeyword(page, crn) {
  const candidates = [
    page.getByLabel(/keyword/i),
    page.getByPlaceholder(/keyword/i),
    page.locator('input[name*="keyword" i]'),
    page.locator('input[id*="keyword" i]'),
  ];
  for (const candidate of candidates) {
    try {
      const count = await candidate.count();
      if (count) {
        await candidate.first().fill(crn, { timeout: 5000 });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

async function submitSearch(page) {
  const candidates = [
    page.getByRole('button', { name: /search/i }),
    page.locator('button:has-text("Search")'),
    page.locator('input[type="submit"]'),
  ];
  for (const candidate of candidates) {
    try {
      const count = await candidate.count();
      if (count) {
        await candidate.first().click({ timeout: 5000 });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }
  await page.keyboard.press('Enter').catch(() => {});
  return false;
}

// Return the text of the actual result card for this search — not the
// search/filter summary bar. Verified against the live site two ways:
//   1. The CRN is NEVER printed as visible text in the result card (it shows
//      subject/catalog number, title, "This section is full"/open wording,
//      section number, meeting time, instructor — never the CRN digits). It
//      only reappears at the bottom in a "Search Criteria" recap ("Keyword:
//      19465", "Class Status: Open or Full Classes").
//   2. The CRN DOES exist in the DOM, but only as a data attribute on the
//      result link (e.g. `data-key="crn:19465"`, `data-matched="crn:19465"`)
//      — never in textContent/innerText.
// So the primary strategy queries for that attribute and walks up to the
// enclosing `.result` row. If that lookup ever fails to match (markup
// change), this falls back to slicing the rendered body text between the
// "Search Results" heading and the following "Search Criteria" recap, which
// is the real result content and excludes the filter bar by construction.
// `classifyStatus` still strips the "Open or Full Classes" filter phrase
// defensively in case either boundary ever shifts.
async function extractSnippet(page, crn) {
  return page.evaluate((needle) => {
    const COURSE_KEYWORDS = [
      'subject', 'instructor', 'professor', 'credit', 'days', 'time', 'seats',
      'capacity', 'enrolled', 'remaining', 'title', 'room', 'building',
      'section', 'meets', 'schedule type',
    ];

    function isFilterOnly(text) {
      const lower = text.toLowerCase();
      const hasCourseContext = COURSE_KEYWORDS.some((k) => lower.includes(k));
      const looksLikeFilterBar =
        lower.includes('keyword:') ||
        lower.includes('class status:') ||
        (lower.includes('term:') && lower.includes('campus:'));
      return looksLikeFilterBar && !hasCourseContext;
    }

    function cleanText(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    let attributeMatch = null;
    try {
      attributeMatch =
        document.querySelector(`[data-key*="crn:${needle}"]`) ||
        document.querySelector(`[data-matched*="crn:${needle}"]`);
    } catch {
      attributeMatch = null;
    }

    if (attributeMatch) {
      const container =
        attributeMatch.closest('.result') ||
        attributeMatch.closest('[class*="result" i]') ||
        attributeMatch.closest('tr') ||
        attributeMatch.closest('li') ||
        attributeMatch.parentElement;
      const text = cleanText(container);
      if (text && !isFilterOnly(text)) {
        return { best: text.slice(0, 500), foundAny: true };
      }
    }

    const bodyText = (document.body.innerText || '').replace(/\r/g, '');

    const resultsMatch = bodyText.match(/search results/i);
    if (!resultsMatch) {
      // No "Search Results" heading rendered at all — page didn't load the
      // results view we expect (e.g. search never actually ran).
      return { best: null, foundAny: Boolean(attributeMatch) };
    }
    const resultsIdx = resultsMatch.index + resultsMatch[0].length;

    const criteriaMatch = bodyText.slice(resultsIdx).match(/search criteria/i);
    const resultsEnd = criteriaMatch ? resultsIdx + criteriaMatch.index : bodyText.length;

    const resultsText = bodyText.slice(resultsIdx, resultsEnd).replace(/\s+/g, ' ').trim();

    if (!resultsText || isFilterOnly(resultsText)) {
      // We're clearly on the results page (found "Search Results"/"Search
      // Criteria"), but nothing between them looks like real course content
      // — the only thing found is the filter summary itself.
      return { best: null, foundAny: true };
    }

    return { best: resultsText.slice(0, 500), foundAny: true };
  }, crn);
}

function classifyStatus(snippet) {
  if (!snippet) return 'unknown';

  // The search filter bar always echoes this exact phrase back
  // ("Class Status: Open or Full Classes"); strip it so it can never be
  // mistaken for a real open/full/closed status word, even if it leaked into
  // a snippet alongside real result context.
  const withoutFilterPhrase = snippet.replace(/open or full classes/gi, ' ');
  const s = withoutFilterPhrase.toLowerCase();

  if (/\bclosed\b/.test(s) || /\bfull\b/.test(s)) return 'closed';
  if (/\bopen\b/.test(s)) return 'open';

  const match = s.match(/(?:seats?\s*(?:avail(?:able)?|remaining)?|remaining|available)\D{0,5}(-?\d+)/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (!Number.isNaN(n)) return n > 0 ? 'open' : 'closed';
  }

  // Verified against the live site: a genuinely open section carries NO
  // status wording at all — the "This section is full" label (and its
  // warning icon) only appears on full/closed sections. So if this is a
  // real result row (has section/meeting-time context) and none of the
  // closed/full signals above matched, the section is open.
  const looksLikeRealResult = /section number|meets:|instructor:/.test(s);
  if (looksLikeRealResult) return 'open';

  return 'unknown';
}

function summarizeCourse(snippet) {
  if (!snippet) return '(unknown course)';

  const text = snippet.replace(/\s+/g, ' ').trim();
  const boundary = text.search(/\b(?:section number|meets|instructor|credits?|schedule type|room|building|seats?|capacity|enrolled|remaining|available):/i);
  const summary = (boundary === -1 ? text : text.slice(0, boundary)).trim();

  return summary || '(unknown course)';
}

async function checkCrn(browser, term, crn) {
  const page = await browser.newPage();
  try {
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const termSelected = await selectTerm(page, term);
    if (!termSelected) {
      console.log(`[CRN ${crn}] WARNING: could not select term "${term}"; continuing with default term.`);
    }

    const keywordFilled = await fillKeyword(page, crn);
    if (!keywordFilled) {
      console.log(`[CRN ${crn}] ERROR: could not find a Keyword field on the page.`);
      await saveDebugArtifacts(page, `${crn}-no-keyword-field`);
      return { crn, status: 'unknown', snippet: null };
    }

    await submitSearch(page);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const extraction = await extractSnippet(page, crn).catch(() => null);
    const snippet = extraction ? extraction.best : null;
    let debugLabel = null;

    if (!snippet && extraction && extraction.foundAny) {
      console.log(`[CRN ${crn}] Only filter summary found, no real result row detected.`);
      debugLabel = `${crn}-filter-only`;
    }

    const status = classifyStatus(snippet);

    if (!debugLabel && status === 'unknown') {
      debugLabel = `${crn}-unknown`;
    }

    if (debugLabel) {
      await saveDebugArtifacts(page, debugLabel);
    }

    return { crn, status, snippet };
  } catch (err) {
    console.log(`[CRN ${crn}] ERROR while checking: ${err.message}`);
    await saveDebugArtifacts(page, `${crn}-error`);
    return { crn, status: 'unknown', snippet: null };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  if (CRNS.length === 0) {
    console.log('No CRNs configured. Set ND_CRNS to a comma-separated list of CRNs (e.g. "12345,67890").');
    process.exit(0);
  }

  console.log(`Checking term "${TERM}" for CRNs: ${CRNS.join(', ')}`);

  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const crn of CRNS) {
      const result = await checkCrn(browser, TERM, crn);
      results.push(result);

      console.log(`\n[CRN ${result.crn}] status: ${result.status.toUpperCase()}`);
      console.log(`[CRN ${result.crn}] snippet: ${result.snippet ? result.snippet : '(no snippet found — CRN may not exist for this term, or the page layout changed)'}`);
    }
  } finally {
    await browser.close();
  }

  const openResults = results.filter((r) => r.status === 'open');

  console.log('\n--- Summary ---');
  for (const r of results) {
    console.log(`CRN ${r.crn}: ${r.status}`);
  }

  if (openResults.length > 0) {
    console.log('\nOPEN COURSE(S) DETECTED\n');
    for (const result of openResults) {
      console.log(`CRN: ${result.crn}`);
      console.log(`Course: ${summarizeCourse(result.snippet)}`);
      console.log(`Details: ${result.snippet ? result.snippet : '(no snippet found)'}`);
      console.log('');
    }
    console.log('GO TO NOVO NOW.');
    process.exit(1);
  }

  console.log('\nNo open seats detected.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  // Exit code 2 = script/infra failure, distinct from "0 = all closed" and
  // "1 = seat may be open", so a crashed run is never mistaken for either.
  process.exit(2);
});
