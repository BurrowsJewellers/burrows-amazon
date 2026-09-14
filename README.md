# burrows-amazon

Lists the Burrows Jewellers catalogue on Amazon AU, and shows what didn't list and why.

Runs on the droplet as a pm2 service, served at
`https://dashboard.burrowsjewellers.com.au/amazon/` behind the existing nginx —
the same arrangement `/ring-builder/` uses.

## The rules this system will not break

**Three brands never reach Amazon: Von Treskow, Pandora, Kirstin Ash.** Enforced at
selection, re-checked immediately before every API call, and swept daily against the
live Amazon listing set. The ban follows the *supplier code* as well as the brand
field, because Pandora items arrive from Retail Edge with no brand on them — only
supplier `PANDO` identifies them. A product whose brand cannot be resolved at all is
also not listed; unknown is treated as unsafe.

**Matching is by barcode only.** Never by title, never by keyword, not as a fallback
and not behind a flag. Matching products by title has already cost this business
refunds for shipping customers the wrong item. A product matches Amazon's catalogue on
an exact GTIN or it is not listed.

**An exact barcode match is still checked before it lists.** Amazon's catalogue is
seller-entered and unverified, so a GTIN can be attached to the wrong product. Real
examples found in the live catalogue on 14 Sep 2026:

| Our product | What Amazon has on that barcode |
|---|---|
| Citizen Gents Stainless Steel Watch | Maui Jim Snapback sunglasses |
| PdPaola Mini Letter **W** Necklace | Mini Letter **N** Necklace |
| Ania Haie Silver Pearl Link Bracelet | Stack Ring Co Infinity bracelet |

A barcode whose product disagrees is recorded as a **conflict**: permanently blocked,
shown with the evidence side by side, and never listable from the interface. The only
thing that clears it is the barcode changing in Retail Edge.

## Where the data comes from

Reads the existing `retailedge_shopify` Postgres database, which already holds a
mirror of the **whole** Shopify store — Burrows, Jewellery65 and warehouse/dropship
products alike (13,548 variants; dropship SKUs are design numbers like `J2827A`).
That mirror is refreshed nightly by the Laravel sync app's 04:00 reconciler.

This service owns its own tables (`amazon_*`) and never writes to the sync app's.

## Layout

    src/amazon/    SP-API: auth, throttled client, catalogue, listings
    src/match/     GTIN validation, confidence scoring, the matching pass
    src/routes/    JSON API for the frontend
    web/           React pages served at /amazon/
    db/schema.sql  Tables this service owns

## Configuration

Copy `.env.example` to `.env`. Amazon credentials already exist in the sync app's
`.env` on the droplet and can be copied across. `AMAZON_CHANNEL_ENABLED=false` is the
master switch: with it off, nothing is ever written to Amazon.
