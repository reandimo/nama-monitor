import { Page, BrowserContext } from '@playwright/test';

const AGE_VERIFIED_STORAGE_KEY = 'nama_age_verified';

export async function bypassAgeGate(context: BrowserContext): Promise<void> {
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
