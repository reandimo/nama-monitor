import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';

const ctx = fs.existsSync('results.json')
  ? fs.readFileSync('results.json', 'utf-8').slice(0, 10_000)
  : 'sin contexto';

const SITES = ['https://heynama.com', 'https://getnama.com'];

let report = '';
for await (const msg of query({
  prompt: `URGENTE: el test E2E del funnel de Nama falló. Hay Meta Ads y Google Ads activos gastando dinero hacia estos sitios:
${SITES.join(', ')}

Resultado del test:
${ctx}

Contexto del stack (importante para diagnosticar):
- WordPress + WooCommerce + tema "nama" (block theme).
- Age gate: modal en la home y PDP que se cierra escribiendo localStorage 'nama_age_verified' = '1'. El test ya lo bypasea via addInitScript.
- Carrito: plugin "WPC Fly Cart" (woofc_*). El éxito de Add-to-Cart se mide por incremento de [data-cart-fragment="cart-count"].
- Checkout: AL HACER CLICK EN /checkout/, WordPress redirige al checkout de Shopify (nama-cbd.myshopify.com) via la Storefront API. ESTE BRIDGE ES LA PARTE MÁS FRÁGIL DEL FUNNEL.
- Producto de prueba: /product/the-ultimate-nama-sampler/.

Tareas:
1. Visitá cada dominio. Bypassá el age gate (botón data-age-gate-yes con texto "Yes, I'm at least 21") si aparece.
2. Andá a /product/the-ultimate-nama-sampler/, hacé click en Add to Cart.
3. Visitá /checkout/. Confirmá si el browser termina en nama-cbd.myshopify.com sin error, o si rompe en el camino.
4. Identificá EXACTAMENTE en qué paso rompe en cada dominio (puede romper uno y el otro no).
5. Causa probable — considerá especialmente:
   - 5xx en heynama/getnama (hosting / WP caído)
   - JS error en home o PDP (consola del browser)
   - Producto sin stock o slug cambió
   - Plugin de carrito (woo-fly-cart, wpc-ajax-add-to-cart) actualizado y rompió el botón o las fragments
   - Bridge Shopify roto: token Storefront expirado/rotado, producto sin shopify_id ACF, selling plan ID inválido, schema GraphQL deprecated
   - Shopify devuelve error en su checkout (cart vacío, producto deshabilitado del lado Shopify, geo-block)
   - Cloudflare/WAF bloqueando IPs de GitHub Actions (síntoma: HTML extraño, challenge page)
6. Severidad: ¿está el funnel de Ads roto (no se puede comprar) o solo cosmético?

Devolvé en español, con este formato exacto:
- 🔴/🟡 SEVERIDAD
- DOMINIO afectado: heynama / getnama / ambos
- PASO que falla (home / PDP / add-to-cart / redirect a Shopify / checkout en Shopify)
- CAUSA probable (sé específico — apuntá a un plugin, un token, un selector concreto)
- ACCIÓN sugerida (ej: revertir woo-fly-cart, regenerar token Storefront en Shopify.php, restablecer stock, contactar hosting)`,
  options: {
    mcpServers: {
      playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
    },
    maxTurns: 30,
  },
})) {
  if (msg.type === 'result') report = msg.result;
}

const text = `🚨 *FUNNEL DE NAMA CAÍDO* 🚨\n_Meta/Google Ads sigue gastando_\n\n${report}`;

const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.error('SLACK_WEBHOOK_URL no está seteado — el reporte no se va a publicar.');
  console.log(report);
  process.exit(1);
}

await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, link_names: 1 }),
});
console.log(report);
