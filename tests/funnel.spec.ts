import { test, expect } from '@playwright/test';
import { bypassAgeGate, clickAgeGateIfPresent, isCloudflareChallenge, recordTestFailure } from './utils';

// On any test failure, classify whether it was caused by a Cloudflare bot
// challenge. The workflow uses the resulting log files (failures.log,
// cf-failures.log) to decide whether to fire a Slack alert — CF-only failures
// are suppressed.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const cfChallenge = await isCloudflareChallenge(page);
  recordTestFailure(testInfo.title, cfChallenge);
});

const SITES = [
  { name: 'heynama', baseURL: 'https://heynama.com' },
  { name: 'getnama', baseURL: 'https://getnama.com' },
];
const PRODUCT_SLUG = 'the-ultimate-nama-sampler';
// Shopify checkout puede servirse desde el dominio raw de Shopify o desde el dominio
// branded que Nama configuró como "checkout domain" en Shopify Admin. Ambos son válidos.
const SHOPIFY_CHECKOUT_URL_RE = /^https:\/\/(nama-cbd\.myshopify\.com|www\.namacbd\.com)\/checkouts\//;
const ADD_TO_CART_SELECTOR = 'button.single_add_to_cart_button, .single_add_to_cart_button';

for (const site of SITES) {
  test.describe(site.name, () => {
    test.beforeEach(async ({ context }) => {
      await bypassAgeGate(context);
    });

    test('smoke: home + product page load', async ({ page }) => {
      const homeRes = await page.goto(site.baseURL, { waitUntil: 'domcontentloaded' });
      expect(homeRes?.status(), `home ${site.baseURL}`).toBeLessThan(400);
      await clickAgeGateIfPresent(page);

      const prodRes = await page.goto(`${site.baseURL}/product/${PRODUCT_SLUG}/`, { waitUntil: 'domcontentloaded' });
      expect(prodRes?.status(), `pdp /product/${PRODUCT_SLUG}/`).toBeLessThan(400);
      await clickAgeGateIfPresent(page);

      await expect(page.locator(ADD_TO_CART_SELECTOR).first()).toBeVisible();
    });

    test('e2e: add to cart and redirect to Shopify checkout', async ({ page }) => {
      await page.goto(`${site.baseURL}/product/${PRODUCT_SLUG}/`, { waitUntil: 'domcontentloaded' });
      await clickAgeGateIfPresent(page);

      const addToCartBtn = page.locator(ADD_TO_CART_SELECTOR).first();
      await expect(addToCartBtn).toBeEnabled({ timeout: 10_000 });
      await addToCartBtn.click();

      // Esperar a que la AJAX response del plugin wpc-ajax-add-to-cart termine.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

      // Success signal: the WPC Fly Cart drawer auto-opens after a successful
      // add-to-cart by toggling `woofc-show` on <body>. This is pure client-side
      // JS in the plugin, so it works even when the page cache serves stale
      // [data-cart-fragment="cart-count"] values (see getnama caching issue).
      // Belt-and-suspenders: also accept the cart drawer being visible by its
      // own selector in case the plugin updates the class name.
      await expect
        .poll(
          async () =>
            (await page.locator('body.woofc-show').count()) > 0 ||
            (await page.locator('.woofc-inner, [class*="woofc"][class*="open"]').first().isVisible().catch(() => false)),
          { timeout: 15_000, message: 'WPC Fly Cart drawer did not open after Add to Cart' }
        )
        .toBe(true);

      // Confirm the test product actually landed in the drawer (catches the case
      // where the drawer opens but the click added a different product or none).
      await expect(
        page.getByText(/the ultimate nama sampler/i).first()
      ).toBeVisible({ timeout: 10_000 });

      const checkoutRes = await page.goto(`${site.baseURL}/checkout/`, { waitUntil: 'domcontentloaded' });

      expect(page.url(), 'expected redirect to a Shopify checkout URL').toMatch(SHOPIFY_CHECKOUT_URL_RE);

      expect(checkoutRes?.status(), `shopify checkout ${page.url()}`).toBeLessThan(400);
    });
  });
}
