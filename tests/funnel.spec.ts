import { test, expect, type Locator } from '@playwright/test';
import { bypassAgeGate, clickAgeGateIfPresent } from './utils';

const SITES = [
  { name: 'heynama', baseURL: 'https://heynama.com' },
  { name: 'getnama', baseURL: 'https://getnama.com' },
];
const PRODUCT_SLUG = 'the-ultimate-nama-sampler';
// Shopify checkout puede servirse desde el dominio raw de Shopify o desde el dominio
// branded que Nama configuró como "checkout domain" en Shopify Admin. Ambos son válidos.
const SHOPIFY_CHECKOUT_URL_RE = /^https:\/\/(nama-cbd\.myshopify\.com|www\.namacbd\.com)\/checkouts\//;
const ADD_TO_CART_SELECTOR = 'button.single_add_to_cart_button, .single_add_to_cart_button';
const CART_COUNT_SELECTOR = '[data-cart-fragment="cart-count"]';

async function readCount(locator: Locator): Promise<number> {
  const txt = (await locator.textContent()) ?? '0';
  const n = parseInt(txt.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

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

      const cartCount = page.locator(CART_COUNT_SELECTOR).first();
      await expect(cartCount).toBeVisible({ timeout: 10_000 });
      const initialCount = await readCount(cartCount);

      const addToCartBtn = page.locator(ADD_TO_CART_SELECTOR).first();
      await expect(addToCartBtn).toBeEnabled({ timeout: 10_000 });
      await addToCartBtn.click();

      // Esperar a que la AJAX response del plugin wpc-ajax-add-to-cart termine.
      // En getnama esto puede tardar; el catch evita romper si la página entra
      // en full reload (en cuyo caso networkidle se cumple solo).
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

      await expect
        .poll(async () => readCount(cartCount), {
          timeout: 30_000,
          message: 'cart-count fragment did not increment after Add to Cart',
        })
        .toBeGreaterThan(initialCount);

      const checkoutRes = await page.goto(`${site.baseURL}/checkout/`, { waitUntil: 'domcontentloaded' });

      expect(page.url(), 'expected redirect to a Shopify checkout URL').toMatch(SHOPIFY_CHECKOUT_URL_RE);

      expect(checkoutRes?.status(), `shopify checkout ${page.url()}`).toBeLessThan(400);
    });
  });
}
