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

-- Stage 2: our own brand, listed by creating the product page rather than matching an
-- existing one. Kept separate from amazon_listings, which is keyed on barcode — these
-- pieces have none, which is the whole reason they need this route.
create table if not exists amazon_own_brand (
  sku            text primary key,
  vendor         text,
  title          text,
  description    text,
  price          numeric(10,2),
  qty            integer,
  product_type   text,
  amazon_type    text,
  metal          text,
  stone          text,
  colour         text,
  ring_size      text,
  us_ring_size   text,
  image_url      text,
  image_count    integer,
  state          text not null default 'draft',
  --   draft      not looked at yet
  --   not_ready  something Amazon insists on is missing from our own data
  --   ready      Amazon validated it; waiting only on brand approval
  --   blocked    Amazon refused it for a reason we cannot fix from here
  --   stage1     Amazon already carries the barcode; it is an offer, not a new page
  --   listed     created on Amazon
  state_reason   text,
  issues         jsonb,
  assumed        text[],                    -- attributes guessed rather than read
  validated_at   timestamptz,
  listed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists amazon_own_brand_state_idx on amazon_own_brand (state);

-- Which attributes were guessed rather than read from our own records. Added after the
-- table existed, so it needs its own alter: "create table if not exists" skips a table
-- that is already there, column list and all.
alter table amazon_own_brand add column if not exists assumed text[];

-- Amazon orders, and what became of them in Shopify.
--
-- The Amazon order id is the primary key, which is what makes this safe to run every
-- few minutes: an order already carried across cannot be carried across twice.
create table if not exists amazon_orders (
  amazon_order_id   text primary key,
  purchase_date     timestamptz,
  order_status      text,                     -- Amazon's: Unshipped, Shipped, Canceled…
  fulfilment        text,                     -- MFN (we ship) or AFN (Amazon ships)
  order_total       numeric(10,2),
  currency          text,
  ship_city         text,
  ship_state        text,
  ship_postcode     text,
  ship_country      text,
  has_full_address  boolean not null default false,
  shopify_order_id  bigint,
  shopify_order_name text,
  state             text not null default 'seen',
  --   seen     read from Amazon, nothing done with it yet
  --   ready    every line maps to a product; waiting only on permission to write
  --   created  a Shopify order exists for it
  --   held     something about it needs a person — an unmapped line, usually
  --   ignored  cancelled, or fulfilled by Amazon, so not ours to push
  state_reason      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists amazon_order_items (
  id                bigserial primary key,
  amazon_order_id   text not null references amazon_orders (amazon_order_id) on delete cascade,
  order_item_id     text,
  sku               text,
  asin              text,
  title             text,
  quantity          integer,
  item_price        numeric(10,2),
  shopify_variant_id bigint,                  -- null means we could not place the line
  created_at        timestamptz not null default now()
);

create unique index if not exists amazon_order_items_line_idx
  on amazon_order_items (amazon_order_id, order_item_id);
create index if not exists amazon_orders_state_idx on amazon_orders (state);
