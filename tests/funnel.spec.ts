import { test, expect, type Locator } from '@playwright/test';
import { bypassAgeGate, clickAgeGateIfPresent } from './utils';

const SITES = [
  { name: 'heynama', baseURL: 'https://heynama.com' },
  { name: 'getnama', baseURL: 'https://getnama.com' },
];
const PRODUCT_SLUG = 'the-ultimate-nama-sampler';
const SHOPIFY_HOST = 'nama-cbd.myshopify.com';
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

    test('smoke: home + producto cargan', async ({ page }) => {
      const homeRes = await page.goto(site.baseURL, { waitUntil: 'domcontentloaded' });
      expect(homeRes?.status(), `home ${site.baseURL}`).toBeLessThan(400);
      await clickAgeGateIfPresent(page);

      const prodRes = await page.goto(`${site.baseURL}/product/${PRODUCT_SLUG}/`, { waitUntil: 'domcontentloaded' });
      expect(prodRes?.status(), `pdp /product/${PRODUCT_SLUG}/`).toBeLessThan(400);
      await clickAgeGateIfPresent(page);

      await expect(page.locator(ADD_TO_CART_SELECTOR).first()).toBeVisible();
    });

    test('e2e: agregar al carrito y redirigir a checkout de Shopify', async ({ page }) => {
      await page.goto(`${site.baseURL}/product/${PRODUCT_SLUG}/`, { waitUntil: 'domcontentloaded' });
      await clickAgeGateIfPresent(page);

      const cartCount = page.locator(CART_COUNT_SELECTOR).first();
      await expect(cartCount).toBeVisible({ timeout: 10_000 });
      const initialCount = await readCount(cartCount);

      await page.locator(ADD_TO_CART_SELECTOR).first().click();

      await expect
        .poll(async () => readCount(cartCount), {
          timeout: 15_000,
          message: 'cart-count fragment did not increment after Add to Cart',
        })
        .toBeGreaterThan(initialCount);

      const checkoutRes = await page.goto(`${site.baseURL}/checkout/`, { waitUntil: 'domcontentloaded' });

      const finalHost = new URL(page.url()).hostname;
      expect(finalHost, `expected redirect to ${SHOPIFY_HOST}, got ${page.url()}`).toBe(SHOPIFY_HOST);

      expect(checkoutRes?.status(), `shopify checkout ${page.url()}`).toBeLessThan(400);
    });
  });
}
