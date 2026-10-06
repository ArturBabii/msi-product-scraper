# MSI Product Page Scraper

A small Playwright (JavaScript) scraper for one MSI US Store product page:
[MAG Z890 TOMAHAWK WIFI](https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI).

It opens the page in headless Chromium, reads the product data from the live DOM, normalizes it and writes `output/product.json`.

## Run

Requires Node.js 18+.

```bash
npm install
npx playwright install chromium
npm run scrape
```

`output/product.json` is created or overwritten on every run. A sample output is committed.

## Project structure

```
src/
  scrape.js      # browser setup, page loading, DOM extraction, building the result
  normalize.js   # pure helpers: text cleanup, price/rating parsing, availability mapping
output/
  product.json   # sample output
```

## Where each field comes from

The page has no JSON-LD or Open Graph product data, so the scraper reads the rendered DOM.
All selectors are kept in one `SELECTORS` object in `src/scrape.js`.

| Field | Source |
| --- | --- |
| `item_id` | hidden `input[name="product_id"]` (OpenCart product ID) |
| `title` | `.product-detail h2.title` |
| `brand` | text before the product name in `<title>` ("**MSI** MAG Z890 ... - MSI-US Official Store") |
| `category_tree`, `product_category` | `ol.breadcrumb`, without "Home" and the current product |
| `description` | short summary paragraph right under the title |
| `price`, `sale_price` | `#prices-new` inside `#prices-wrapper`. If an old (struck-through) price or a `discount` in the page's `gtag("view_item")` event is present, the old price becomes `price` and the current one `sale_price` |
| `availability` | stock label in `#prices-wrapper` ("In Stock" → `in_stock`) |
| `image_url` | main gallery image `#imagePopup` |
| `additional_image_urls` | full-size `popup_img` of gallery thumbnails, swiper clones skipped, deduplicated |
| `specs` | "Detail Specification" tables (`th` / `td` rows); multi-line values joined with `; ` |
| `star_rating`, `review_count` | `#average-rating-info` ("4.7 (3)") |
| `mpn` | "Manufacturer Number" spec row |
| `gtin` | a GTIN/UPC/EAN spec row if present; this page has none, so `null` |

Missing values are `null`, list fields are `[]`, and placeholders such as `-` are treated as missing.

## Notes

- **Bot protection.** The store is behind Akamai, which returns `403 Access Denied` to Playwright's default
  headless shell and to the `HeadlessChrome` User-Agent. The scraper launches the full Chromium build in
  new headless mode (`channel: 'chromium'`, installed by `npx playwright install chromium`) with the regular
  Chrome User-Agent of the same build. That is enough to get the normal page, without stealth plugins.
- The meta `description` tag on this page describes a different board (Z890 GAMING PLUS WIFI), so it is not used.
- If the page fails to load (non-2xx status or the title never appears), the scraper prints the error and
  exits with code 1 without overwriting the previous output.
