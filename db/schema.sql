-- Tables owned by burrows-amazon. Nothing here writes to the sync app's tables;
-- the store mirror (shopify_product_variants, shopify_products) is read-only to us.

-- Every product we have considered for Amazon, and what came of it.
create table if not exists amazon_listings (
  barcode         text primary key,
  sku             text not null,
  vendor          text,
  our_title       text,
  our_price       numeric(10,2),
  our_cost        numeric(10,2),
  qty             integer not null default 0,
  source          char(1),                       -- R = Retail Edge, W = warehouse/dropship

  asin            text,
  amazon_title    text,
  amazon_brand    text,

  -- where this product stands. One value, always set, never null:
  --   candidate  we have not looked it up yet
  --   ready      matched and trusted; may be listed
  --   listed     an offer is live on Amazon
  --   no_match   Amazon has no listing for this barcode
  --   conflict   the barcode points at a different product - permanently blocked
  --   blocked    a rule refused it (banned brand, no stock, margin floor)
  --   failed     Amazon rejected the offer; see amazon_errors
  state           text not null default 'candidate',
  state_reason    text,

  -- why we do or do not trust the match
  confidence      text,                          -- high | review | conflict
  match_note      text,

  amazon_price    numeric(10,2),                 -- what Amazon currently shows for our offer
  amazon_qty      integer,
  last_pushed_at  timestamptz,
  checked_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists amazon_listings_state_idx  on amazon_listings (state);
create index if not exists amazon_listings_vendor_idx on amazon_listings (vendor);
create index if not exists amazon_listings_sku_idx    on amazon_listings (sku);

-- Barcode conflicts, kept separately because they are evidence, not a status.
-- A row here means: this barcode resolves to a different product on Amazon.
-- Never deleted automatically - it is the record of why we refuse to list.
create table if not exists amazon_conflicts (
  id            bigserial primary key,
  barcode       text not null,
  sku           text not null,
  our_title     text,
  our_vendor    text,
  our_price     numeric(10,2),
  asin          text,
  amazon_title  text,
  amazon_brand  text,
  amazon_image  text,
  reason        text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (barcode, asin)
);

-- Everything Amazon refused, grouped by cause in the interface.
create table if not exists amazon_errors (
  id          bigserial primary key,
  barcode     text,
  sku         text,
  operation   text not null,                     -- offer_create | price_push | qty_push
  code        text,                              -- Amazon's error code
  message     text,                              -- Amazon's words
  plain       text,                              -- ours: what it means
  fix         text,                              -- ours: what to do about it
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists amazon_errors_open_idx on amazon_errors (code) where resolved_at is null;

-- One row per run of anything, so the interface can show what happened and when.
create table if not exists amazon_runs (
  id          bigserial primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          integer not null default 0,
  failed      integer not null default 0,
  skipped     integer not null default 0,
  note        text
);

-- What Amazon is actually doing with each offer, as opposed to whether we sent it.
-- Sending succeeds long before a listing is buyable, and Amazon can suppress one
-- afterwards without telling anyone, so this is read back rather than assumed.
alter table amazon_listings add column if not exists listing_status text;
alter table amazon_listings add column if not exists buyable boolean;
alter table amazon_listings add column if not exists status_checked_at timestamptz;
