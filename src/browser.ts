/**
 * Playwright Browser Module -- Track 5a Browser Excellence.
 *
 * Singleton BrowserManager with stealth mode, session persistence,
 * screenshot capture, and form automation helpers.
 *
 * Pattern: follows venice.ts (exported async functions, pino logger).
 * Sessions persist via browser_sessions DB table + storageState JSON files.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import { chromium as playwrightChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { logger } from './logger.js';
import {
  saveBrowserSession,
  getBrowserSession,
  getBrowserSessionByDomain,
  listBrowserSessions as dbListSessions,
  touchBrowserSession,
  deleteBrowserSession,
  type BrowserSession,
} from './db.js';

import type { Browser, BrowserContext, Page } from 'playwright';

// ── Config ────────────────────────────────────────────────────────────

const BROWSER_DIR = path.resolve('workspace/browser');
const PROFILES_DIR = path.join(BROWSER_DIR, 'profiles');
const SCREENSHOTS_DIR = path.join(BROWSER_DIR, 'screenshots');
const DOWNLOADS_DIR = path.join(BROWSER_DIR, 'downloads');

const MAX_PAGES = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min auto-close
const NAV_TIMEOUT_MS = 30_000;
const SELECTOR_TIMEOUT_MS = 10_000;

// Domains that should always use stealth
const STEALTH_DOMAINS = new Set([
  'instagram.com', 'www.instagram.com',
  'twitter.com', 'x.com', 'www.x.com',
  'linkedin.com', 'www.linkedin.com',
  'facebook.com', 'www.facebook.com',
  'tiktok.com', 'www.tiktok.com',
  'youtube.com', 'www.youtube.com',
]);

// ── Types ─────────────────────────────────────────────────────────────

export interface BrowseOptions {
  stealth?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  timeout?: number;
  sessionId?: string; // Load a saved session before navigating
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string; // Screenshot a specific element
  path?: string;     // Custom save path (default: auto-generated)
}

export interface TypeOptions {
  delay?: number; // Delay between keystrokes in ms (human-like)
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  timeout?: number;
}

export interface PageResult {
  url: string;
  title: string;
  status: number | null;
}

// ── Browser Manager (singleton) ───────────────────────────────────────

class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private stealthEnabled = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pageCount = 0;

  /** Launch browser (lazy -- only starts when first needed). */
  async launch(stealth = false): Promise<void> {
    if (this.browser?.isConnected()) {
      // Already running -- if stealth mode changed, restart
      if (stealth !== this.stealthEnabled) {
        await this.close();
      } else {
        this.resetIdleTimer();
        return;
      }
    }

    this.stealthEnabled = stealth;

    if (stealth) {
      playwrightChromium.use(StealthPlugin());
    }

    const launchFn = stealth ? playwrightChromium : (await import('playwright')).chromium;

    this.browser = await launchFn.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
    });

    this.context.setDefaultTimeout(SELECTOR_TIMEOUT_MS);
    this.context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    this.pageCount = 0;

    logger.info({ stealth }, 'Browser launched');
    this.resetIdleTimer();
  }

  /** Get the active page, or create one if none exists. */
  async getPage(): Promise<Page> {
    if (!this.browser?.isConnected() || !this.context) {
      await this.launch(this.stealthEnabled);
    }

    if (!this.page || this.page.isClosed()) {
      if (this.pageCount >= MAX_PAGES) {
        // Close oldest pages to stay under limit
        const pages = this.context!.pages();
        if (pages.length > 0) {
          await pages[0].close();
          this.pageCount--;
        }
      }
      this.page = await this.context!.newPage();
      this.pageCount++;
    }

    this.resetIdleTimer();
    return this.page;
  }

  /** Load a saved session (cookies + localStorage) into the current context. */
  async loadSession(session: BrowserSession): Promise<void> {
    if (!session.storage_state) return;

    // Close current context and create new one with saved state
    if (this.context) {
      await this.context.close();
    }

    const storageState = JSON.parse(session.storage_state);

    this.context = await this.browser!.newContext({
      storageState,
      viewport: {
        width: session.viewport_width || 1280,
        height: session.viewport_height || 720,
      },
      userAgent: session.user_agent || undefined,
      acceptDownloads: true,
    });

    this.context.setDefaultTimeout(SELECTOR_TIMEOUT_MS);
    this.context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    this.page = null;
    this.pageCount = 0;

    try { touchBrowserSession(session.id); } catch { /* DB may not be init'd */ }
    logger.info({ domain: session.domain, sessionId: session.id }, 'Browser session loaded');
  }

  /** Save the current context state to DB + file. */
  async saveSession(domain: string, label?: string): Promise<string> {
    if (!this.context) throw new Error('No browser context active');

    const storageState = await this.context.storageState();
    const stateJson = JSON.stringify(storageState);
    const id = randomBytes(4).toString('hex');

    // Save to DB
    saveBrowserSession(id, domain, stateJson, label);

    // Also save to file as backup
    const safeFilename = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = path.join(PROFILES_DIR, `${safeFilename}.json`);
    fs.writeFileSync(filePath, stateJson);

    logger.info({ domain, id, filePath }, 'Browser session saved');
    return id;
  }

  /** Clean shutdown. */
  async close(): Promise<void> {
    this.clearIdleTimer();
    if (this.context) {
      try { await this.context.close(); } catch { /* ignore */ }
      this.context = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
    this.page = null;
    this.pageCount = 0;
    logger.info('Browser closed');
  }

  /** Check if browser is alive. */
  isActive(): boolean {
    return !!this.browser?.isConnected();
  }

  /** Get current stealth state. */
  isStealth(): boolean {
    return this.stealthEnabled;
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logger.info('Browser idle timeout -- closing');
      void this.close();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

// Singleton
const manager = new BrowserManager();

// ── Exported Functions (Skill/Workflow API) ────────────────────────────

// -- Lifecycle --

export async function browserLaunch(stealth = false): Promise<void> {
  await manager.launch(stealth);
}

export async function browserClose(): Promise<void> {
  await manager.close();
}

export function browserIsActive(): boolean {
  return manager.isActive();
}

// -- Navigation --

export async function browserGoto(url: string, opts: BrowseOptions = {}): Promise<PageResult> {
  // Auto-enable stealth for known social media domains
  const hostname = new URL(url).hostname;
  const needsStealth = opts.stealth ?? STEALTH_DOMAINS.has(hostname);

  if (needsStealth && !manager.isStealth()) {
    await manager.launch(true);
  } else if (!manager.isActive()) {
    await manager.launch(needsStealth);
  }

  // Load saved session if requested or auto-detect by domain
  try {
    if (opts.sessionId) {
      const session = getBrowserSession(opts.sessionId);
      if (session) await manager.loadSession(session);
    } else {
      const session = getBrowserSessionByDomain(hostname);
      if (session) await manager.loadSession(session);
    }
  } catch {
    // DB not initialized or session lookup failed -- continue without session
    logger.debug({ hostname }, 'Session auto-load skipped (DB unavailable)');
  }

  const page = await manager.getPage();

  try {
    const response = await page.goto(url, {
      waitUntil: opts.waitUntil || 'domcontentloaded',
      timeout: opts.timeout || NAV_TIMEOUT_MS,
    });

    const title = await page.title();
    logger.info({ url, title, status: response?.status() }, 'Page loaded');

    return {
      url: page.url(),
      title,
      status: response?.status() ?? null,
    };
  } catch (err) {
    // Retry once on timeout
    logger.warn({ url, err }, 'Navigation failed, retrying once');
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: (opts.timeout || NAV_TIMEOUT_MS) * 2,
    });
    const title = await page.title();
    return { url: page.url(), title, status: response?.status() ?? null };
  }
}

// -- Interaction --

export async function browserClick(selector: string, opts: ClickOptions = {}): Promise<void> {
  const page = await manager.getPage();
  await page.click(selector, {
    button: opts.button || 'left',
    clickCount: opts.clickCount || 1,
    timeout: opts.timeout || SELECTOR_TIMEOUT_MS,
  });
  logger.debug({ selector }, 'Clicked element');
}

export async function browserFill(selector: string, value: string): Promise<void> {
  const page = await manager.getPage();
  await page.fill(selector, value);
  logger.debug({ selector, valueLen: value.length }, 'Filled field');
}

export async function browserType(selector: string, text: string, opts: TypeOptions = {}): Promise<void> {
  const page = await manager.getPage();
  await page.click(selector);
  await page.keyboard.type(text, { delay: opts.delay || 50 });
  logger.debug({ selector, textLen: text.length, delay: opts.delay || 50 }, 'Typed text');
}

export async function browserPress(key: string): Promise<void> {
  const page = await manager.getPage();
  await page.keyboard.press(key);
  logger.debug({ key }, 'Pressed key');
}

export async function browserSelect(selector: string, value: string): Promise<void> {
  const page = await manager.getPage();
  await page.selectOption(selector, value);
  logger.debug({ selector, value }, 'Selected option');
}

export async function browserWait(selector: string, timeout?: number): Promise<void> {
  const page = await manager.getPage();
  await page.waitForSelector(selector, {
    state: 'visible',
    timeout: timeout || SELECTOR_TIMEOUT_MS,
  });
  logger.debug({ selector }, 'Element visible');
}

export async function browserWaitForNavigation(timeout?: number): Promise<void> {
  const page = await manager.getPage();
  await page.waitForLoadState('domcontentloaded', { timeout: timeout || NAV_TIMEOUT_MS });
}

// -- Content Extraction --

export async function browserScreenshot(opts: ScreenshotOptions = {}): Promise<string> {
  const page = await manager.getPage();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = opts.path || path.join(SCREENSHOTS_DIR, `${timestamp}.png`);

  if (opts.selector) {
    const element = await page.$(opts.selector);
    if (element) {
      await element.screenshot({ path: filePath });
    } else {
      throw new Error(`Selector "${opts.selector}" not found for screenshot`);
    }
  } else {
    await page.screenshot({
      path: filePath,
      fullPage: opts.fullPage ?? false,
    });
  }

  logger.info({ filePath, fullPage: opts.fullPage }, 'Screenshot captured');
  return filePath;
}

export async function browserContent(): Promise<string> {
  const page = await manager.getPage();
  return page.content();
}

export async function browserText(selector?: string): Promise<string> {
  const page = await manager.getPage();
  if (selector) {
    const el = await page.$(selector);
    if (!el) return '';
    return (await el.textContent()) || '';
  }
  return page.innerText('body');
}

export async function browserUrl(): Promise<string> {
  const page = await manager.getPage();
  return page.url();
}

export async function browserTitle(): Promise<string> {
  const page = await manager.getPage();
  return page.title();
}

export async function browserEval(script: string): Promise<unknown> {
  const page = await manager.getPage();
  return page.evaluate(script);
}

// -- Session Management --

export async function browserSaveSession(domain: string, label?: string): Promise<string> {
  return manager.saveSession(domain, label);
}

export async function browserLoadSession(domainOrId: string): Promise<boolean> {
  try {
    // Try by ID first, then by domain
    let session = getBrowserSession(domainOrId);
    if (!session) {
      session = getBrowserSessionByDomain(domainOrId);
    }
    if (!session) {
      logger.warn({ domainOrId }, 'No browser session found');
      return false;
    }

    if (!manager.isActive()) {
      await manager.launch();
    }

    await manager.loadSession(session);
    return true;
  } catch {
    logger.warn({ domainOrId }, 'Session load failed (DB unavailable)');
    return false;
  }
}

/**
 * Load a browser session from a raw storageState JSON file.
 * Bypasses DB entirely -- used when DB isn't initialized (CLI, first-run).
 */
export async function browserLoadSessionFromFile(filePath: string): Promise<boolean> {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stateJson = fs.readFileSync(filePath, 'utf-8');
    const storageState = JSON.parse(stateJson);

    if (!manager.isActive()) {
      await manager.launch(true); // stealth for social media
    }

    const fakeSession: BrowserSession = {
      id: 'file-session',
      domain: 'x.com',
      storage_state: JSON.stringify(storageState),
      viewport_width: 1280,
      viewport_height: 720,
      user_agent: null,
      label: 'file-loaded',
      created_at: Date.now(),
      last_used: Date.now(),
      expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days
    };

    await manager.loadSession(fakeSession);
    logger.info({ filePath }, 'Browser session loaded from file');
    return true;
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to load session from file');
    return false;
  }
}

export function browserListSessions(): BrowserSession[] {
  try {
    return dbListSessions();
  } catch {
    return [];
  }
}

export async function browserClearSession(domainOrId: string): Promise<void> {
  try {
    // Try by ID
    const byId = getBrowserSession(domainOrId);
    if (byId) {
      deleteBrowserSession(byId.id);
      // Remove profile file too
      const safeFilename = byId.domain.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filePath = path.join(PROFILES_DIR, `${safeFilename}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      logger.info({ id: byId.id, domain: byId.domain }, 'Browser session cleared');
      return;
    }

    // Try by domain
    const byDomain = getBrowserSessionByDomain(domainOrId);
    if (byDomain) {
      deleteBrowserSession(byDomain.id);
      const safeFilename = byDomain.domain.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filePath = path.join(PROFILES_DIR, `${safeFilename}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      logger.info({ id: byDomain.id, domain: byDomain.domain }, 'Browser session cleared');
    }
  } catch {
    logger.warn({ domainOrId }, 'Session clear failed (DB unavailable)');
  }
}

// -- Utilities --

export async function browserPdf(filePath: string): Promise<string> {
  const page = await manager.getPage();
  await page.pdf({ path: filePath, format: 'A4' });
  logger.info({ filePath }, 'PDF generated');
  return filePath;
}

export async function browserCookies(): Promise<Array<{ name: string; value: string; domain: string }>> {
  const page = await manager.getPage();
  const url = page.url();
  if (!url || url === 'about:blank') return [];
  return page.context().cookies(url);
}

/** Health check: can we launch and close a browser? */
export async function browserHealthCheck(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/** Get capabilities summary. */
export function browserCapabilities(): {
  installed: boolean;
  stealthAvailable: boolean;
  maxPages: number;
  idleTimeoutMs: number;
} {
  return {
    installed: true,
    stealthAvailable: true,
    maxPages: MAX_PAGES,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  };
}
