const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const {
  cleanText,
  parsePrice,
  parseRating,
  normalizeAvailability,
  uniq,
} = require('./normalize');

const TARGET_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';
const OUTPUT_FILE = path.join(__dirname, '..', 'output', 'product.json');
const TIMEOUT_MS = 60_000;

// Selectors in one place, so a markup change only needs one edit.
const SELECTORS = {
  title: '.product-detail h2.title',
  shortDescription: '.product-detail h2.title + div',
  breadcrumbItems: 'ol.breadcrumb li.breadcrumb-item',
  priceBlock: '#prices-wrapper',
  currentPrice: '#prices-new',
  oldPrice: '.prices-old, .price-old, del, s',
  productId: 'input[name="product_id"]',
  mainImage: '#imagePopup',
  // Swiper clones slides for looping; skip the clones to keep the original order.
  galleryImages: '#carouselImages .swiper-slide:not(.swiper-slide-duplicate) img[popup_img]',
  rating: '#average-rating-info',
  specRows: 'table tr',
};

/**
 * The store sits behind Akamai, which answers 403 to Playwright's default
 * headless shell and to the "HeadlessChrome/..." User-Agent. Running the full
 * Chromium build in new headless mode (channel: 'chromium') with the regular
 * Chrome UA of the same build is enough to get the normal page.
 */
async function openBrowser() {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const userAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const context = await browser.newContext({ userAgent, locale: 'en-US' });
  return { browser, page: await context.newPage() };
}

async function loadProductPage(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  if (!response || !response.ok()) {
    throw new Error(`Failed to load ${url}: HTTP ${response ? response.status() : 'no response'}`);
  }
  await page.waitForSelector(SELECTORS.title, { timeout: TIMEOUT_MS });
}

/** Reads raw strings from the DOM. All normalization happens later in Node. */
async function extractRawData(page) {
  return page.evaluate((sel) => {
    const text = (selector, root = document) => root.querySelector(selector)?.textContent ?? null;
    // innerText keeps <br>/<li> line breaks; turn them into "; " separators.
    const multiline = (el) =>
      (el.innerText || el.textContent)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('; ');

    const priceBlock = document.querySelector(sel.priceBlock);

    return {
      documentTitle: document.title,
      title: text(sel.title),
      description: text(sel.shortDescription),
      productId: document.querySelector(sel.productId)?.value ?? null,
      breadcrumbs: [...document.querySelectorAll(sel.breadcrumbItems)].map((li) => ({
        name: li.textContent,
        url: li.querySelector('a')?.href ?? null,
        isCurrent: li.classList.contains('active'),
      })),
      currentPrice: text(sel.currentPrice),
      oldPrice: priceBlock ? text(sel.oldPrice, priceBlock) : null,
      availability: priceBlock?.textContent ?? null,
      mainImage: document.querySelector(sel.mainImage)?.src ?? null,
      galleryImages: [...document.querySelectorAll(sel.galleryImages)].map((img) =>
        new URL(img.getAttribute('popup_img'), location.href).href,
      ),
      rating: text(sel.rating),
      specs: [...document.querySelectorAll(sel.specRows)]
        .map((row) => ({ th: row.querySelector('th'), td: row.querySelector('td') }))
        .filter(({ th, td }) => th && td)
        .map(({ th, td }) => ({ name: th.textContent, value: multiline(td) })),
      // gtag "view_item" event holds the price/discount the store reports to analytics.
      analyticsScript:
        [...document.scripts].map((s) => s.textContent).find((t) => t.includes('"view_item"')) ?? null,
    };
  }, SELECTORS);
}

/** Parses the gtag("event", "view_item", {...}) payload, or returns null. */
function parseAnalyticsItem(script) {
  const match = script?.match(/gtag\(\s*"event"\s*,\s*"view_item"\s*,\s*(\{.*\})\s*\)/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]).items?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The page has no explicit brand field. Its <title> looks like
 * "MSI MAG Z890 TOMAHAWK WIFI ATX Motherboard - MSI-US Official Store",
 * so the brand is the text before the product name.
 */
function extractBrand(documentTitle, productTitle) {
  if (!documentTitle || !productTitle) return null;
  const index = documentTitle.indexOf(productTitle);
  return index > 0 ? cleanText(documentTitle.slice(0, index)) : null;
}

/** Old price present -> it is the regular price and the current one is the sale price. */
function extractPrices(raw, analyticsItem) {
  const current = parsePrice(raw.currentPrice) ?? analyticsItem?.price ?? null;
  const old = parsePrice(raw.oldPrice);
  if (old && current && old > current) return { price: old, sale_price: current };

  const discount = Number(analyticsItem?.discount) || 0;
  if (discount > 0 && current) {
    return { price: Number((current + discount).toFixed(2)), sale_price: current };
  }
  return { price: current, sale_price: null };
}

function findSpec(specs, pattern) {
  return specs.find((spec) => pattern.test(spec.name))?.value ?? null;
}

function buildProduct(raw, url) {
  const title = cleanText(raw.title);
  const analyticsItem = parseAnalyticsItem(raw.analyticsScript);

  // Skip "Home" and the last crumb (the product itself).
  const categoryTree = raw.breadcrumbs
    .filter((crumb) => !crumb.isCurrent && cleanText(crumb.name)?.toLowerCase() !== 'home')
    .map((crumb) => ({ name: cleanText(crumb.name), url: crumb.url || null }))
    .filter((crumb) => crumb.name);

  const specs = raw.specs
    .map((spec) => ({ name: cleanText(spec.name), value: cleanText(spec.value) }))
    .filter((spec) => spec.name);

  const imageUrl = raw.mainImage || null;
  const { rating, count } = parseRating(raw.rating);

  return {
    url,
    item_id: cleanText(raw.productId),
    title,
    brand: extractBrand(raw.documentTitle, title),
    product_category: categoryTree.length ? categoryTree.map((c) => c.name).join(' > ') : null,
    category_tree: categoryTree,
    description: cleanText(raw.description),
    ...extractPrices(raw, analyticsItem),
    availability: normalizeAvailability(raw.availability),
    image_url: imageUrl,
    additional_image_urls: uniq(raw.galleryImages).filter((src) => src !== imageUrl),
    specs,
    star_rating: rating,
    review_count: count,
    gtin: findSpec(specs, /\b(gtin|upc|ean)\b/i),
    mpn: findSpec(specs, /manufacturer (part )?number|\bmpn\b/i),
    scraped_at: new Date().toISOString(),
  };
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  const { browser, page } = await openBrowser();
  try {
    console.log(`Opening ${TARGET_URL}`);
    await loadProductPage(page, TARGET_URL);

    const raw = await extractRawData(page);
    const product = buildProduct(raw, page.url());

    await saveJson(OUTPUT_FILE, product);
    console.log(`Saved "${product.title}" (${product.specs.length} specs) to ${OUTPUT_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Scraping failed:', error.message);
  process.exitCode = 1;
});
