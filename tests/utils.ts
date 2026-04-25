import { Page, BrowserContext } from '@playwright/test';

const AGE_VERIFIED_STORAGE_KEY = 'nama_age_verified';

// Mask common headless-detection signals so Cloudflare Bot Fight Mode doesn't
// flag the runner. Targets the specific checks Cloudflare reported failing
// (userAgentCheck — handled by dropping the custom UA in playwright.config.ts;
// appVersionCheck — handled here) plus the standard navigator.webdriver giveaway.
async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // 1. navigator.webdriver — the most obvious bot signal
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // 2. navigator.appVersion — Cloudflare's appVersionCheck inspects this
    //    against the User-Agent. Default headless Chromium has "HeadlessChrome"
    //    here even when the UA is normal Chrome.
    const realAppVersion = navigator.appVersion.replace(/HeadlessChrome/g, 'Chrome');
    Object.defineProperty(navigator, 'appVersion', {
      get: () => realAppVersion,
    });

    // 3. navigator.userAgent — also strip HeadlessChrome if present
    const realUA = navigator.userAgent.replace(/HeadlessChrome/g, 'Chrome');
    Object.defineProperty(navigator, 'userAgent', {
      get: () => realUA,
    });

    // 4. window.chrome — real Chrome exposes this object; headless does not
    if (!('chrome' in window)) {
      (window as unknown as { chrome: object }).chrome = { runtime: {} };
    }

    // 5. navigator.plugins — must be non-empty in real Chrome
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
      ],
    });

    // 6. navigator.languages — headless sometimes returns []
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // 7. permissions.query notification quirk — headless reports "denied"
    //    while Notification.permission says "default", which is detectable.
    const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
    if (originalQuery) {
      navigator.permissions.query = (params: PermissionDescriptor) =>
        params.name === 'notifications'
          ? Promise.resolve({
              state: Notification.permission as PermissionState,
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false,
            } as PermissionStatus)
          : originalQuery(params);
    }
  });
}

export async function bypassAgeGate(context: BrowserContext): Promise<void> {
  await applyStealth(context);

  await context.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // Private browsing / storage disabled — fall through to clickAgeGateIfPresent.
    }
  }, AGE_VERIFIED_STORAGE_KEY);
}

export async function clickAgeGateIfPresent(page: Page): Promise<void> {
  const yesBtn = page.locator('[data-age-gate-yes]').first();
  if (await yesBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await yesBtn.click();
  }
}
