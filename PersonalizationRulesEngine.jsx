/**
 * StoreIQ — Ecommerce Personalization Rules Engine
 * =================================================
 *
 * A self-contained, fully client-side rules engine that classifies a live
 * shopper session into one of five behavioural states and recommends the
 * next-best personalization action ("nudge").
 *
 * Design principles:
 *   - `computeFeatures(events)` and `classifySession(events)` are PURE
 *     functions with zero side effects. They can be lifted out of this file
 *     and unit-tested in Node with no React present.
 *   - Every rule is a named, weighted, self-explaining constant. The evidence
 *     panel renders exactly what the engine computed — nothing is hardcoded.
 *   - All magic numbers (weights, thresholds, decay multipliers, saturation
 *     anchors) live in the TUNING CONSTANTS section below, each with a
 *     comment explaining the reasoning.
 *
 * File layout:
 *   1. Event schema            — event type enum + typedefs
 *   2. Tuning constants        — every knob the engine has
 *   3. Feature extraction      — computeFeatures(events)
 *   4. Classification rules    — five states, weighted signal + decay rules
 *   5. Rules engine core       — classifySession(events)
 *   6. Simulator data          — catalog, metadata generators, presets
 *   7. UI                      — React components (simulator / output / evidence)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// 1. EVENT SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every behavioural event the engine understands.
 * @enum {string}
 */
const EVENT_TYPES = Object.freeze({
  PAGE_VIEW: "PAGE_VIEW",
  PRODUCT_VIEW: "PRODUCT_VIEW",
  CATEGORY_VIEW: "CATEGORY_VIEW",
  SEARCH: "SEARCH",
  ADD_TO_CART: "ADD_TO_CART",
  REMOVE_FROM_CART: "REMOVE_FROM_CART",
  WISHLIST_ADD: "WISHLIST_ADD",
  COUPON_SEARCH: "COUPON_SEARCH",
  COUPON_APPLIED: "COUPON_APPLIED",
  CHECKOUT_STARTED: "CHECKOUT_STARTED",
  CHECKOUT_ABANDONED: "CHECKOUT_ABANDONED",
  PURCHASE_COMPLETED: "PURCHASE_COMPLETED",
  RETURN_VISIT: "RETURN_VISIT",
  REVIEW_READ: "REVIEW_READ",
  PRICE_CHECK: "PRICE_CHECK",
  FILTER_USED: "FILTER_USED",
});

/** @typedef {typeof EVENT_TYPES[keyof typeof EVENT_TYPES]} EventType */

/**
 * Optional context attached to an event. Only the fields relevant to the
 * event type are populated (e.g. `searchQuery` on SEARCH, `timeOnPage` on
 * PRODUCT_VIEW).
 *
 * @typedef {Object} EventMetadata
 * @property {string=} productId       SKU identifier
 * @property {string=} productName     Display name
 * @property {string=} category        Product / category name
 * @property {number=} price           Unit price in USD
 * @property {number=} discountPercent 0-100, present on coupon & purchase events
 * @property {string=} searchQuery     Raw query text for SEARCH events
 * @property {number=} timeOnPage      Seconds spent on the page (PRODUCT_VIEW)
 */

/**
 * A single event in the session stream.
 *
 * @typedef {Object} ShopperEvent
 * @property {string} id          Unique id from crypto.randomUUID()
 * @property {EventType} type
 * @property {number} timestamp   Epoch milliseconds
 * @property {EventMetadata=} metadata
 */

// ═══════════════════════════════════════════════════════════════════════════
// 2. TUNING CONSTANTS
// Every magic number in the engine, named and explained. Changing behaviour
// should never require touching rule logic — only these knobs.
// ═══════════════════════════════════════════════════════════════════════════

// ── Scoring ────────────────────────────────────────────────────────────────
/** Confidences are expressed on a 0-100 scale. */
const CONFIDENCE_MAX = 100;
/** Spec: surface a secondary classification only above this confidence. */
const SECONDARY_MIN_CONFIDENCE = 30;
/** A rule scoring below this is rendered as "not triggered" in the evidence UI. */
const RULE_TRIGGER_THRESHOLD = 0.15;
/**
 * Low-data damping: confidence scales linearly with event count until this
 * many events exist. One or two events should never produce a near-certain
 * classification — the engine must earn its confidence.
 */
const MIN_EVENTS_FOR_FULL_CONFIDENCE = 6;

// ── Dwell-time interpretation (seconds on a product page) ─────────────────
/** At or below this dwell the shopper is skimming — a Browser signal. */
const SKIM_DWELL_S = 12;
/** At or above this dwell the shopper is studying — a Comparer signal. */
const STUDY_DWELL_S = 45;

// ── Idle detection after cart activity (Cart Abandoner) ───────────────────
/** Gaps below this after cart activity are normal navigation, not idling. */
const IDLE_AFTER_CART_MIN_MS = 15_000;
/** Gaps at or above this after cart activity read as walking away. */
const IDLE_AFTER_CART_FULL_MS = 45_000;

// ── Sequence windows ───────────────────────────────────────────────────────
/** Events scanned before a REMOVE_FROM_CART for price/coupon activity. */
const PRICE_SIGNAL_LOOKBACK = 3;
/** First product view → purchase inside this window = decisive buy (contradicts Comparer). */
const QUICK_PURCHASE_MS = 3 * 60_000;
/** A search query with at most this many words reads as exploratory ("sale", "new arrivals"). */
const BROAD_QUERY_MAX_WORDS = 2;

// ── Saturation anchors ─────────────────────────────────────────────────────
// The observed value at which a signal's score reaches its full 1.0. Between
// zero and the anchor the score is linear, so evidence contributions grow
// smoothly instead of flipping on/off.
const BROWSING_SHARE_FULL = 0.5; // ≥50% page/category views = pure browsing
const CATEGORY_BREADTH_FULL = 4; // touring 4+ categories = maximal breadth
const LOW_CART_RATIO_CEILING = 0.3; // add-to-cart ratio above 30% stops looking like browsing
const MIN_VIEWS_FOR_CART_JUDGEMENT = 3; // don't judge cart apathy on fewer than 3 views
const EXPLORATORY_SEARCHES_FULL = 2; // two broad searches = fully exploratory
const SAME_CATEGORY_VIEWS_FULL = 3; // spec: 3+ product views in one category = deep dive
const FILTERS_FULL = 2; // two filter refinements = methodical narrowing
const REVIEWS_FULL = 2; // two review reads = active research
const PRICE_CHECKS_FULL = 2; // two price checks = active comparison
const WISHLIST_FULL = 2; // two wishlist saves = deliberate shortlisting
const WISHLIST_CART_RATIO_CEILING = 0.5; // wishlist-parking only counts while cart ratio is low
const COUPON_SEARCHES_FULL = 2; // two coupon hunts = determined discount seeking
const COUPON_EVENT_SHARE_FULL = 0.2; // ≥20% of all events being coupon events saturates
const REVISITS_WITHOUT_BUYING_FULL = 2; // two returns with no purchase = circling for a deal
const RETURN_VISITS_LOYAL_FULL = 3; // three return visits = habitual shopper
const REPEAT_PURCHASES_FULL = 2; // spec: purchase count >= 2 defines loyalty
const COUPONS_PER_PURCHASE_CEILING = 2; // 2+ coupon hunts per purchase erases "full-price comfort"

// ── Decay multipliers ──────────────────────────────────────────────────────
// Applied multiplicatively to a state's confidence when a contradicting
// signal appears. 1.0 = no decay, 0.0 = total collapse.
const BROWSER_DECAY_ON_CART = 0.6; // an add-to-cart means they're no longer just looking
const BROWSER_DECAY_ON_CHECKOUT = 0.5; // starting checkout firmly contradicts browsing
const COMPARER_DECAY_ON_QUICK_PURCHASE = 0.55; // a fast, decisive buy is not comparison behaviour
const DISCOUNT_DECAY_ON_FULL_PRICE = 0.5; // paying full price contradicts discount seeking
const ABANDONER_DECAY_ON_PURCHASE = 0.3; // spec: drops sharply on PURCHASE_COMPLETED
const LOYAL_DECAY_ON_ABANDON = 0.85; // loyalty is sticky — an abandoned checkout only nicks it

// ── Rule weights ───────────────────────────────────────────────────────────
// Relative importance of each signal inside its state. Every state's weights
// sum to 10 so raw scores are directly comparable across states before decay.
const W_BROWSER = {
  browsingDominant: 3, // the defining signal: session is mostly page/category views
  categoryBreadth: 2, // touring many categories = window shopping
  lowCartEngagement: 2, // looking a lot, committing to nothing
  shallowDwell: 1.5, // skimming product pages rather than studying them
  exploratorySearch: 1.5, // broad, vague queries
};
const W_COMPARER = {
  sameCategoryDeepDive: 3, // the defining signal: repeated product views in one category
  filterRefinement: 1.5, // narrowing the field with filters
  reviewResearch: 1.5, // reading reviews before committing
  priceComparison: 1.5, // explicit price checks
  deliberateDwell: 1.5, // long, careful product-page sessions
  wishlistParking: 1, // shortlisting without carting
};
const W_DISCOUNT = {
  couponHunting: 3, // the defining signal: actively searching for coupons
  couponRedemption: 2, // actually applying a code
  priceDrivenCartEdits: 2, // removing items right after price/coupon checks
  discountEventShare: 1.5, // how much of the whole session is discount-flavoured
  revisitWithoutBuying: 1.5, // circling back repeatedly, waiting for a better price
};
const W_ABANDONER = {
  checkoutWalkaway: 3, // the defining signal: an explicit abandoned checkout
  cartChurn: 2, // items going into the cart and back out
  idleAfterCart: 2, // going quiet right after cart activity
  returnWithoutRecommit: 1.5, // coming back but never re-adding to cart
  abandonRate: 1.5, // fraction of started checkouts that die
};
const W_LOYAL = {
  repeatPurchases: 3.5, // the defining signal: two or more completed purchases
  habitualReturns: 2, // frequent return visits
  postPurchaseEngagement: 1.5, // reading reviews after buying
  fullPriceComfort: 2, // low coupon hunting relative to purchases
  conversionEfficiency: 1, // started checkouts that actually complete
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. FEATURE EXTRACTION — computeFeatures(events)
// ═══════════════════════════════════════════════════════════════════════════

/** Clamp a number into [0, 1]. @param {number} x @returns {number} */
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Division that returns 0 instead of NaN/Infinity. @param {number} n @param {number} d @returns {number} */
const safeDiv = (n, d) => (d > 0 ? n / d : 0);

/** Round to one decimal place. @param {number} x @returns {number} */
const round1 = (x) => Math.round(x * 10) / 10;

/** Format a 0-1 ratio as a percentage string. @param {number} x @returns {string} */
const pct = (x) => `${Math.round(x * 100)}%`;

/** Event types that count as "cart activity" for idle detection. */
const CART_ACTIVITY_TYPES = new Set([
  EVENT_TYPES.ADD_TO_CART,
  EVENT_TYPES.REMOVE_FROM_CART,
  EVENT_TYPES.CHECKOUT_STARTED,
  EVENT_TYPES.CHECKOUT_ABANDONED,
]);

/** Event types that count as "price/discount signals" for cart-edit correlation. */
const PRICE_SIGNAL_TYPES = new Set([
  EVENT_TYPES.PRICE_CHECK,
  EVENT_TYPES.COUPON_SEARCH,
  EVENT_TYPES.COUPON_APPLIED,
]);

/**
 * The complete feature vector computed from a session's event stream.
 * Everything the classification rules can see lives here — the Features tab
 * renders this object verbatim, which is what makes the engine auditable.
 *
 * @typedef {Object} FeatureVector
 * @property {number} totalEvents
 * @property {number} pageViews
 * @property {number} productViews
 * @property {number} categoryViews
 * @property {number} searches
 * @property {number} addToCarts
 * @property {number} removesFromCart
 * @property {number} wishlistAdds
 * @property {number} couponSearches
 * @property {number} couponsApplied
 * @property {number} checkoutsStarted
 * @property {number} checkoutsAbandoned
 * @property {number} purchases
 * @property {number} returnVisits
 * @property {number} reviewsRead
 * @property {number} priceChecks
 * @property {number} filtersUsed
 * @property {number} addToCartRatio        addToCarts / productViews
 * @property {number} cartChurnRatio        removesFromCart / addToCarts
 * @property {number} couponEventRatio      (couponSearches + couponsApplied) / totalEvents
 * @property {number} checkoutAbandonRate   checkoutsAbandoned / checkoutsStarted
 * @property {number} couponsPerPurchase    couponSearches / purchases
 * @property {number} browsingShare         (pageViews + categoryViews) / totalEvents
 * @property {number} broadSearchRatio      share of searches with <= BROAD_QUERY_MAX_WORDS words
 * @property {number} avgTimeOnProductPageS mean metadata.timeOnPage over PRODUCT_VIEW events
 * @property {number} sessionDurationMs     last timestamp - first timestamp
 * @property {number} maxIdleAfterCartMs    longest gap following any cart-activity event
 * @property {?number} msFromFirstProductViewToPurchase null when no view→purchase pair exists
 * @property {number} distinctCategoriesViewed
 * @property {number} maxSameCategoryProductViews
 * @property {number} removesAfterPriceSignal   REMOVE_FROM_CART preceded by a price/coupon event
 * @property {number} returnVisitsWithoutNewCart RETURN_VISIT after cart activity with no later ADD_TO_CART
 * @property {number} postPurchaseReviewReads
 * @property {number} purchasesAtFullPrice      purchases with no discountPercent
 * @property {boolean} wishlistWithoutCart      saved to wishlist but never carted
 */

/**
 * Distils a raw event stream into the feature vector consumed by every
 * classification rule. Pure function: no side effects, no clock reads, no
 * randomness — the same events always produce the same features.
 *
 * @param {ShopperEvent[]} events Chronologically ordered session events.
 * @returns {FeatureVector}
 */
function computeFeatures(events) {
  /** @type {Record<EventType, number>} */
  const counts = Object.fromEntries(Object.values(EVENT_TYPES).map((t) => [t, 0]));
  for (const event of events) counts[event.type] += 1;

  // ── Dwell time on product pages ──
  const dwellSamples = events
    .filter((e) => e.type === EVENT_TYPES.PRODUCT_VIEW && typeof e.metadata?.timeOnPage === "number")
    .map((e) => e.metadata.timeOnPage);
  const avgTimeOnProductPageS = dwellSamples.length
    ? dwellSamples.reduce((sum, s) => sum + s, 0) / dwellSamples.length
    : 0;

  // ── Category breadth vs. depth ──
  const productViewsByCategory = new Map();
  const categoriesSeen = new Set();
  for (const e of events) {
    const category = e.metadata?.category;
    if (!category) continue;
    if (e.type === EVENT_TYPES.PRODUCT_VIEW) {
      productViewsByCategory.set(category, (productViewsByCategory.get(category) ?? 0) + 1);
      categoriesSeen.add(category);
    } else if (e.type === EVENT_TYPES.CATEGORY_VIEW) {
      categoriesSeen.add(category);
    }
  }
  const maxSameCategoryProductViews = Math.max(0, ...productViewsByCategory.values());

  // ── Search breadth ──
  const searchEvents = events.filter((e) => e.type === EVENT_TYPES.SEARCH);
  const broadSearches = searchEvents.filter((e) => {
    const words = (e.metadata?.searchQuery ?? "").trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= BROAD_QUERY_MAX_WORDS;
  }).length;

  // ── Sequence pattern: cart removals right after price/coupon activity ──
  let removesAfterPriceSignal = 0;
  events.forEach((e, i) => {
    if (e.type !== EVENT_TYPES.REMOVE_FROM_CART) return;
    const lookback = events.slice(Math.max(0, i - PRICE_SIGNAL_LOOKBACK), i);
    if (lookback.some((prior) => PRICE_SIGNAL_TYPES.has(prior.type))) removesAfterPriceSignal += 1;
  });

  // ── Sequence pattern: longest silence following any cart-activity event ──
  let maxIdleAfterCartMs = 0;
  for (let i = 0; i < events.length - 1; i += 1) {
    if (CART_ACTIVITY_TYPES.has(events[i].type)) {
      maxIdleAfterCartMs = Math.max(maxIdleAfterCartMs, events[i + 1].timestamp - events[i].timestamp);
    }
  }

  // ── Sequence pattern: returned to the site but never re-committed to the cart ──
  let returnVisitsWithoutNewCart = 0;
  events.forEach((e, i) => {
    if (e.type !== EVENT_TYPES.RETURN_VISIT) return;
    const cartActivityBefore = events.slice(0, i).some((p) => p.type === EVENT_TYPES.ADD_TO_CART);
    const newCartAfter = events.slice(i + 1).some((p) => p.type === EVENT_TYPES.ADD_TO_CART);
    if (cartActivityBefore && !newCartAfter) returnVisitsWithoutNewCart += 1;
  });

  // ── Sequence pattern: review reads that happen after a completed purchase ──
  let postPurchaseReviewReads = 0;
  let purchasesSeen = 0;
  for (const e of events) {
    if (e.type === EVENT_TYPES.PURCHASE_COMPLETED) purchasesSeen += 1;
    else if (e.type === EVENT_TYPES.REVIEW_READ && purchasesSeen > 0) postPurchaseReviewReads += 1;
  }

  // ── Full-price purchases (no discount attached) ──
  const purchasesAtFullPrice = events.filter(
    (e) => e.type === EVENT_TYPES.PURCHASE_COMPLETED && !(e.metadata?.discountPercent > 0)
  ).length;

  // ── Time from first product view to first purchase after it ──
  const firstProductView = events.find((e) => e.type === EVENT_TYPES.PRODUCT_VIEW);
  const firstPurchaseAfterView = firstProductView
    ? events.find((e) => e.type === EVENT_TYPES.PURCHASE_COMPLETED && e.timestamp >= firstProductView.timestamp)
    : undefined;
  const msFromFirstProductViewToPurchase =
    firstProductView && firstPurchaseAfterView
      ? firstPurchaseAfterView.timestamp - firstProductView.timestamp
      : null;

  const totalEvents = events.length;

  return {
    totalEvents,
    pageViews: counts[EVENT_TYPES.PAGE_VIEW],
    productViews: counts[EVENT_TYPES.PRODUCT_VIEW],
    categoryViews: counts[EVENT_TYPES.CATEGORY_VIEW],
    searches: counts[EVENT_TYPES.SEARCH],
    addToCarts: counts[EVENT_TYPES.ADD_TO_CART],
    removesFromCart: counts[EVENT_TYPES.REMOVE_FROM_CART],
    wishlistAdds: counts[EVENT_TYPES.WISHLIST_ADD],
    couponSearches: counts[EVENT_TYPES.COUPON_SEARCH],
    couponsApplied: counts[EVENT_TYPES.COUPON_APPLIED],
    checkoutsStarted: counts[EVENT_TYPES.CHECKOUT_STARTED],
    checkoutsAbandoned: counts[EVENT_TYPES.CHECKOUT_ABANDONED],
    purchases: counts[EVENT_TYPES.PURCHASE_COMPLETED],
    returnVisits: counts[EVENT_TYPES.RETURN_VISIT],
    reviewsRead: counts[EVENT_TYPES.REVIEW_READ],
    priceChecks: counts[EVENT_TYPES.PRICE_CHECK],
    filtersUsed: counts[EVENT_TYPES.FILTER_USED],
    addToCartRatio: safeDiv(counts[EVENT_TYPES.ADD_TO_CART], counts[EVENT_TYPES.PRODUCT_VIEW]),
    cartChurnRatio: safeDiv(counts[EVENT_TYPES.REMOVE_FROM_CART], counts[EVENT_TYPES.ADD_TO_CART]),
    couponEventRatio: safeDiv(
      counts[EVENT_TYPES.COUPON_SEARCH] + counts[EVENT_TYPES.COUPON_APPLIED],
      totalEvents
    ),
    checkoutAbandonRate: safeDiv(counts[EVENT_TYPES.CHECKOUT_ABANDONED], counts[EVENT_TYPES.CHECKOUT_STARTED]),
    couponsPerPurchase: safeDiv(counts[EVENT_TYPES.COUPON_SEARCH], counts[EVENT_TYPES.PURCHASE_COMPLETED]),
    browsingShare: safeDiv(counts[EVENT_TYPES.PAGE_VIEW] + counts[EVENT_TYPES.CATEGORY_VIEW], totalEvents),
    broadSearchRatio: safeDiv(broadSearches, searchEvents.length),
    avgTimeOnProductPageS,
    sessionDurationMs: totalEvents >= 2 ? events[totalEvents - 1].timestamp - events[0].timestamp : 0,
    maxIdleAfterCartMs,
    msFromFirstProductViewToPurchase,
    distinctCategoriesViewed: categoriesSeen.size,
    maxSameCategoryProductViews,
    removesAfterPriceSignal,
    returnVisitsWithoutNewCart,
    postPurchaseReviewReads,
    purchasesAtFullPrice,
    wishlistWithoutCart: counts[EVENT_TYPES.WISHLIST_ADD] > 0 && counts[EVENT_TYPES.ADD_TO_CART] === 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. CLASSIFICATION RULES — five states, each with weighted signal rules,
//    decay rules for contradicting evidence, and a recommended nudge.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A weighted signal rule. `evaluate` maps the feature vector to a score in
 * [0, 1]; the engine multiplies it by `weight` and normalises.
 *
 * @typedef {Object} SignalRule
 * @property {string} rule                          Human-readable name (shown in the evidence UI)
 * @property {number} weight                        Relative importance within the state's rule set
 * @property {(f: FeatureVector) => number} evaluate Returns 0..1
 * @property {(f: FeatureVector) => string} explain  Plain-English explanation with live values
 */

/**
 * A decay rule: a contradicting signal that multiplies the state's confidence
 * down when it applies.
 *
 * @typedef {Object} DecayRule
 * @property {string} rule                           Human-readable name
 * @property {number} multiplier                     Applied to confidence when the rule fires (0..1)
 * @property {(f: FeatureVector) => boolean} applies
 * @property {(f: FeatureVector) => string} explain
 */

/**
 * The recommended personalization action for a state.
 *
 * @typedef {Object} Nudge
 * @property {string} headline   Short imperative title for the action card
 * @property {string} directive  The full recommendation (from the playbook spec)
 * @property {string[]} actions  Concrete steps a CRM/personalization system would take
 */

/**
 * A complete shopper-state definition.
 *
 * @typedef {Object} ShopperState
 * @property {string} id
 * @property {string} label
 * @property {string} definition  Formal one-sentence definition of the state
 * @property {string} color       Accent hex — palette validated for CVD separation & 3:1 contrast on slate-900
 * @property {{text: string, bar: string, chip: string}} classes Tailwind utility classes for the accent
 * @property {SignalRule[]} rules
 * @property {DecayRule[]} decay
 * @property {Nudge} nudge
 */

/** @type {SignalRule[]} */
const BROWSER_RULES = [
  {
    rule: "Browsing-dominant event mix",
    weight: W_BROWSER.browsingDominant,
    evaluate: (f) => clamp01(safeDiv(f.browsingShare, BROWSING_SHARE_FULL)),
    explain: (f) =>
      `${pct(f.browsingShare)} of session events are page/category views — ${pct(
        BROWSING_SHARE_FULL
      )} or more reads as pure browsing.`,
  },
  {
    rule: "Broad category exploration",
    weight: W_BROWSER.categoryBreadth,
    evaluate: (f) => clamp01(f.distinctCategoriesViewed / CATEGORY_BREADTH_FULL),
    explain: (f) =>
      `${f.distinctCategoriesViewed} distinct categor${f.distinctCategoriesViewed === 1 ? "y" : "ies"} touched — ${CATEGORY_BREADTH_FULL}+ signals window-shopping breadth.`,
  },
  {
    rule: "Low cart engagement",
    weight: W_BROWSER.lowCartEngagement,
    evaluate: (f) =>
      f.pageViews + f.productViews >= MIN_VIEWS_FOR_CART_JUDGEMENT
        ? 1 - clamp01(f.addToCartRatio / LOW_CART_RATIO_CEILING)
        : 0,
    explain: (f) =>
      f.pageViews + f.productViews >= MIN_VIEWS_FOR_CART_JUDGEMENT
        ? `Add-to-cart ratio is ${pct(f.addToCartRatio)} — lots of looking, little committing (needs < ${pct(
            LOW_CART_RATIO_CEILING
          )} to score).`
        : `Fewer than ${MIN_VIEWS_FOR_CART_JUDGEMENT} views so far — too early to judge cart apathy.`,
  },
  {
    rule: "Shallow product-page dwell",
    weight: W_BROWSER.shallowDwell,
    evaluate: (f) =>
      f.productViews === 0
        ? 0
        : 1 - clamp01((f.avgTimeOnProductPageS - SKIM_DWELL_S) / (STUDY_DWELL_S - SKIM_DWELL_S)),
    explain: (f) =>
      f.productViews === 0
        ? "No product pages visited yet — dwell time unknown."
        : `Average ${Math.round(f.avgTimeOnProductPageS)}s per product page — under ${SKIM_DWELL_S}s is skimming.`,
  },
  {
    rule: "Exploratory search queries",
    weight: W_BROWSER.exploratorySearch,
    evaluate: (f) => f.broadSearchRatio * clamp01(f.searches / EXPLORATORY_SEARCHES_FULL),
    explain: (f) =>
      f.searches === 0
        ? "No searches yet."
        : `${pct(f.broadSearchRatio)} of ${f.searches} search${f.searches === 1 ? "" : "es"} were broad (≤ ${BROAD_QUERY_MAX_WORDS} words).`,
  },
];

/** @type {DecayRule[]} */
const BROWSER_DECAY = [
  {
    rule: "Cart activity contradicts browsing",
    multiplier: BROWSER_DECAY_ON_CART,
    applies: (f) => f.addToCarts > 0,
    explain: (f) =>
      f.addToCarts > 0
        ? `${f.addToCarts} add-to-cart event${f.addToCarts === 1 ? "" : "s"} — this shopper is past "just looking" (×${BROWSER_DECAY_ON_CART}).`
        : "No cart activity — browsing confidence intact.",
  },
  {
    rule: "Checkout activity contradicts browsing",
    multiplier: BROWSER_DECAY_ON_CHECKOUT,
    applies: (f) => f.checkoutsStarted > 0,
    explain: (f) =>
      f.checkoutsStarted > 0
        ? `Checkout was started — firmly beyond browsing (×${BROWSER_DECAY_ON_CHECKOUT}).`
        : "No checkout activity — browsing confidence intact.",
  },
];

/** @type {SignalRule[]} */
const COMPARER_RULES = [
  {
    rule: "Same-category deep dive",
    weight: W_COMPARER.sameCategoryDeepDive,
    evaluate: (f) => clamp01((f.maxSameCategoryProductViews - 1) / (SAME_CATEGORY_VIEWS_FULL - 1)),
    explain: (f) =>
      `${f.maxSameCategoryProductViews} product view${f.maxSameCategoryProductViews === 1 ? "" : "s"} in the busiest category — ${SAME_CATEGORY_VIEWS_FULL}+ in one category is head-to-head comparison.`,
  },
  {
    rule: "Filter refinement",
    weight: W_COMPARER.filterRefinement,
    evaluate: (f) => clamp01(f.filtersUsed / FILTERS_FULL),
    explain: (f) => `${f.filtersUsed} filter use${f.filtersUsed === 1 ? "" : "s"} — methodically narrowing the field.`,
  },
  {
    rule: "Review research",
    weight: W_COMPARER.reviewResearch,
    evaluate: (f) => clamp01(f.reviewsRead / REVIEWS_FULL),
    explain: (f) => `${f.reviewsRead} review${f.reviewsRead === 1 ? "" : "s"} read — validating options before committing.`,
  },
  {
    rule: "Explicit price comparison",
    weight: W_COMPARER.priceComparison,
    evaluate: (f) => clamp01(f.priceChecks / PRICE_CHECKS_FULL),
    explain: (f) => `${f.priceChecks} price check${f.priceChecks === 1 ? "" : "s"} — weighing cost across options.`,
  },
  {
    rule: "Deliberate product-page dwell",
    weight: W_COMPARER.deliberateDwell,
    evaluate: (f) =>
      f.productViews === 0
        ? 0
        : clamp01((f.avgTimeOnProductPageS - SKIM_DWELL_S) / (STUDY_DWELL_S - SKIM_DWELL_S)),
    explain: (f) =>
      f.productViews === 0
        ? "No product pages visited yet — dwell time unknown."
        : `Average ${Math.round(f.avgTimeOnProductPageS)}s per product page — ${STUDY_DWELL_S}s+ is careful study.`,
  },
  {
    rule: "Wishlist parking without carting",
    weight: W_COMPARER.wishlistParking,
    evaluate: (f) =>
      f.wishlistAdds === 0
        ? 0
        : clamp01(f.wishlistAdds / WISHLIST_FULL) * (1 - clamp01(f.addToCartRatio / WISHLIST_CART_RATIO_CEILING)),
    explain: (f) =>
      f.wishlistAdds === 0
        ? "Nothing wishlisted yet."
        : `${f.wishlistAdds} wishlist save${f.wishlistAdds === 1 ? "" : "s"} while the cart stays cold — shortlisting, not buying.`,
  },
];

/** @type {DecayRule[]} */
const COMPARER_DECAY = [
  {
    rule: "Quick decisive purchase contradicts comparison",
    multiplier: COMPARER_DECAY_ON_QUICK_PURCHASE,
    applies: (f) =>
      f.purchases > 0 &&
      f.msFromFirstProductViewToPurchase !== null &&
      f.msFromFirstProductViewToPurchase < QUICK_PURCHASE_MS,
    explain: (f) =>
      f.purchases > 0 &&
      f.msFromFirstProductViewToPurchase !== null &&
      f.msFromFirstProductViewToPurchase < QUICK_PURCHASE_MS
        ? `Purchased ${Math.round(f.msFromFirstProductViewToPurchase / 1000)}s after the first product view — decisive, not deliberating (×${COMPARER_DECAY_ON_QUICK_PURCHASE}).`
        : "No quick purchase — comparison confidence intact.",
  },
];

/** @type {SignalRule[]} */
const DISCOUNT_SEEKER_RULES = [
  {
    rule: "Active coupon hunting",
    weight: W_DISCOUNT.couponHunting,
    evaluate: (f) => clamp01(f.couponSearches / COUPON_SEARCHES_FULL),
    explain: (f) =>
      `${f.couponSearches} coupon search${f.couponSearches === 1 ? "" : "es"} — ${COUPON_SEARCHES_FULL}+ is determined deal hunting.`,
  },
  {
    rule: "Coupon redemption",
    weight: W_DISCOUNT.couponRedemption,
    evaluate: (f) => clamp01(f.couponsApplied),
    explain: (f) =>
      f.couponsApplied > 0
        ? `${f.couponsApplied} coupon${f.couponsApplied === 1 ? "" : "s"} actually applied — the discount matters to this shopper.`
        : "No coupon applied yet.",
  },
  {
    rule: "Price-driven cart edits",
    weight: W_DISCOUNT.priceDrivenCartEdits,
    evaluate: (f) => clamp01(f.removesAfterPriceSignal),
    explain: (f) =>
      f.removesAfterPriceSignal > 0
        ? `${f.removesAfterPriceSignal} cart removal${f.removesAfterPriceSignal === 1 ? "" : "s"} within ${PRICE_SIGNAL_LOOKBACK} events of a price/coupon check — price is driving cart decisions.`
        : "No cart removals correlated with price checks.",
  },
  {
    rule: "Discount-flavoured session share",
    weight: W_DISCOUNT.discountEventShare,
    evaluate: (f) => clamp01(f.couponEventRatio / COUPON_EVENT_SHARE_FULL),
    explain: (f) =>
      `${pct(f.couponEventRatio)} of all events are coupon-related — ${pct(COUPON_EVENT_SHARE_FULL)}+ saturates this signal.`,
  },
  {
    rule: "Repeat visits without buying",
    weight: W_DISCOUNT.revisitWithoutBuying,
    evaluate: (f) => (f.purchases === 0 ? clamp01(f.returnVisits / REVISITS_WITHOUT_BUYING_FULL) : 0),
    explain: (f) =>
      f.purchases === 0
        ? `${f.returnVisits} return visit${f.returnVisits === 1 ? "" : "s"} with no purchase — circling and waiting for a better price.`
        : "Shopper has purchased — revisits no longer read as deal-waiting.",
  },
];

/** @type {DecayRule[]} */
const DISCOUNT_SEEKER_DECAY = [
  {
    rule: "Full-price purchase contradicts deal seeking",
    multiplier: DISCOUNT_DECAY_ON_FULL_PRICE,
    applies: (f) => f.purchasesAtFullPrice > 0,
    explain: (f) =>
      f.purchasesAtFullPrice > 0
        ? `${f.purchasesAtFullPrice} purchase${f.purchasesAtFullPrice === 1 ? "" : "s"} at full price — this shopper pays sticker (×${DISCOUNT_DECAY_ON_FULL_PRICE}).`
        : "No full-price purchase — deal-seeking confidence intact.",
  },
];

/** @type {SignalRule[]} */
const CART_ABANDONER_RULES = [
  {
    rule: "Explicit checkout walkaway",
    weight: W_ABANDONER.checkoutWalkaway,
    evaluate: (f) => clamp01(f.checkoutsAbandoned),
    explain: (f) =>
      f.checkoutsAbandoned > 0
        ? `${f.checkoutsAbandoned} checkout${f.checkoutsAbandoned === 1 ? "" : "s"} abandoned — the strongest abandonment signal there is.`
        : "No abandoned checkout yet.",
  },
  {
    rule: "Cart churn",
    weight: W_ABANDONER.cartChurn,
    evaluate: (f) => (f.addToCarts > 0 ? clamp01(f.cartChurnRatio) : 0),
    explain: (f) =>
      f.addToCarts > 0
        ? `${f.removesFromCart} of ${f.addToCarts} carted item${f.addToCarts === 1 ? "" : "s"} removed (${pct(
            f.cartChurnRatio
          )} churn).`
        : "Nothing carted yet — churn unknown.",
  },
  {
    rule: "Idle after cart activity",
    weight: W_ABANDONER.idleAfterCart,
    evaluate: (f) =>
      clamp01((f.maxIdleAfterCartMs - IDLE_AFTER_CART_MIN_MS) / (IDLE_AFTER_CART_FULL_MS - IDLE_AFTER_CART_MIN_MS)),
    explain: (f) =>
      f.maxIdleAfterCartMs > 0
        ? `Longest silence after cart activity: ${Math.round(f.maxIdleAfterCartMs / 1000)}s — ${Math.round(
            IDLE_AFTER_CART_FULL_MS / 1000
          )}s+ reads as walking away.`
        : "No measurable idle gap after cart activity.",
  },
  {
    rule: "Return visit without re-committing",
    weight: W_ABANDONER.returnWithoutRecommit,
    evaluate: (f) => clamp01(f.returnVisitsWithoutNewCart),
    explain: (f) =>
      f.returnVisitsWithoutNewCart > 0
        ? `${f.returnVisitsWithoutNewCart} return visit${f.returnVisitsWithoutNewCart === 1 ? "" : "s"} after cart activity with no new add-to-cart — hovering, not recommitting.`
        : "No return visits that ignored the cart.",
  },
  {
    rule: "Checkout abandon rate",
    weight: W_ABANDONER.abandonRate,
    evaluate: (f) => (f.checkoutsStarted > 0 ? clamp01(f.checkoutAbandonRate) : 0),
    explain: (f) =>
      f.checkoutsStarted > 0
        ? `${pct(f.checkoutAbandonRate)} of started checkouts were abandoned.`
        : "No checkouts started yet.",
  },
];

/** @type {DecayRule[]} */
const CART_ABANDONER_DECAY = [
  {
    rule: "Completed purchase redeems the cart",
    multiplier: ABANDONER_DECAY_ON_PURCHASE,
    applies: (f) => f.purchases > 0,
    explain: (f) =>
      f.purchases > 0
        ? `A purchase completed — abandonment risk collapses (×${ABANDONER_DECAY_ON_PURCHASE}).`
        : "No completed purchase — abandonment risk stands.",
  },
];

/** @type {SignalRule[]} */
const LOYAL_CUSTOMER_RULES = [
  {
    rule: "Repeat purchases",
    weight: W_LOYAL.repeatPurchases,
    evaluate: (f) => clamp01(f.purchases / REPEAT_PURCHASES_FULL),
    explain: (f) =>
      `${f.purchases} completed purchase${f.purchases === 1 ? "" : "s"} — ${REPEAT_PURCHASES_FULL}+ defines a repeat customer.`,
  },
  {
    rule: "Habitual return visits",
    weight: W_LOYAL.habitualReturns,
    evaluate: (f) => clamp01(f.returnVisits / RETURN_VISITS_LOYAL_FULL),
    explain: (f) =>
      `${f.returnVisits} return visit${f.returnVisits === 1 ? "" : "s"} — ${RETURN_VISITS_LOYAL_FULL}+ marks a habitual shopper.`,
  },
  {
    rule: "Post-purchase engagement",
    weight: W_LOYAL.postPurchaseEngagement,
    evaluate: (f) => clamp01(f.postPurchaseReviewReads),
    explain: (f) =>
      f.postPurchaseReviewReads > 0
        ? `${f.postPurchaseReviewReads} review${f.postPurchaseReviewReads === 1 ? "" : "s"} read after purchasing — still invested after the sale.`
        : "No post-purchase engagement yet.",
  },
  {
    rule: "Full-price comfort",
    weight: W_LOYAL.fullPriceComfort,
    evaluate: (f) => (f.purchases > 0 ? 1 - clamp01(f.couponsPerPurchase / COUPONS_PER_PURCHASE_CEILING) : 0),
    explain: (f) =>
      f.purchases > 0
        ? `${round1(f.couponsPerPurchase)} coupon search${f.couponsPerPurchase === 1 ? "" : "es"} per purchase — loyal customers buy on trust, not discounts.`
        : "No purchases yet — price sensitivity unknown.",
  },
  {
    rule: "Conversion efficiency",
    weight: W_LOYAL.conversionEfficiency,
    evaluate: (f) => (f.purchases > 0 && f.checkoutsStarted > 0 ? 1 - clamp01(f.checkoutAbandonRate) : 0),
    explain: (f) =>
      f.purchases > 0 && f.checkoutsStarted > 0
        ? `${pct(1 - f.checkoutAbandonRate)} of started checkouts completed — friction-free buying.`
        : "Not enough checkout history to judge conversion.",
  },
];

/** @type {DecayRule[]} */
const LOYAL_CUSTOMER_DECAY = [
  {
    rule: "Abandoned checkout wobbles loyalty slightly",
    multiplier: LOYAL_DECAY_ON_ABANDON,
    applies: (f) => f.checkoutsAbandoned > 0,
    explain: (f) =>
      f.checkoutsAbandoned > 0
        ? `An abandoned checkout nicks loyalty, but loyalty is sticky (×${LOYAL_DECAY_ON_ABANDON}).`
        : "No abandonment — loyalty untouched.",
  },
];

/**
 * The five shopper states, keyed by id.
 * Accent colors were validated as a categorical palette (lightness band,
 * chroma floor, CVD adjacent-pair separation, 3:1 contrast) against the
 * slate-900 surface used by this UI.
 *
 * @type {Record<string, ShopperState>}
 */
const SHOPPER_STATES = Object.freeze({
  BROWSER: {
    id: "BROWSER",
    label: "Browser",
    definition:
      "Drifting across the catalogue — many page and category views, shallow product engagement, no commitment signals.",
    color: "#3b82f6", // Tailwind blue-500
    classes: { text: "text-blue-500", bar: "bg-blue-500", chip: "bg-blue-500/10 border-blue-500/40" },
    rules: BROWSER_RULES,
    decay: BROWSER_DECAY,
    nudge: {
      headline: "Inspire, don't push",
      directive: "Surface trending products and editorial content. Do not push discount yet.",
      actions: ["Show trending-products carousel", "Feature editorial lookbook", "Suppress discount banners"],
    },
  },
  COMPARER: {
    id: "COMPARER",
    label: "Comparer",
    definition:
      "Researching a decision — repeated product views in one category, filters, reviews and price checks, long dwell times.",
    color: "#7c3aed", // Tailwind violet-600
    classes: { text: "text-violet-600", bar: "bg-violet-600", chip: "bg-violet-600/10 border-violet-600/40" },
    rules: COMPARER_RULES,
    decay: COMPARER_DECAY,
    nudge: {
      headline: "Help them decide",
      directive: "Show comparison table, surface top-rated badge, highlight return policy.",
      actions: ["Render side-by-side comparison table", "Pin top-rated badge on best option", "Highlight free-returns policy"],
    },
  },
  DISCOUNT_SEEKER: {
    id: "DISCOUNT_SEEKER",
    label: "Discount Seeker",
    definition:
      "Price-first shopper — hunting coupons, checking prices, editing the cart around discounts, revisiting without buying.",
    color: "#d97706", // Tailwind amber-600
    classes: { text: "text-amber-600", bar: "bg-amber-600", chip: "bg-amber-600/10 border-amber-600/40" },
    rules: DISCOUNT_SEEKER_RULES,
    decay: DISCOUNT_SEEKER_DECAY,
    nudge: {
      headline: "Close with value",
      directive: "Trigger exit-intent with 10% off. Show bundle deals. Surface loyalty points.",
      actions: ["Arm exit-intent modal with 10% code", "Show bundle-and-save offers", "Surface loyalty points balance"],
    },
  },
  CART_ABANDONER: {
    id: "CART_ABANDONER",
    label: "Cart Abandoner",
    definition:
      "Committed then retreated — items carted or checkout started, followed by removal, abandonment or silence.",
    color: "#ef4444", // Tailwind red-500
    classes: { text: "text-red-500", bar: "bg-red-500", chip: "bg-red-500/10 border-red-500/40" },
    rules: CART_ABANDONER_RULES,
    decay: CART_ABANDONER_DECAY,
    nudge: {
      headline: "Recover the cart",
      directive: "Show persistent cart reminder. Send re-engagement email trigger. Offer free shipping threshold.",
      actions: ["Pin persistent cart reminder", "Queue re-engagement email", "Show free-shipping threshold progress"],
    },
  },
  LOYAL_CUSTOMER: {
    id: "LOYAL_CUSTOMER",
    label: "Loyal Customer",
    definition:
      "Established relationship — repeat purchases, habitual return visits, post-purchase engagement, low discount dependence.",
    color: "#059669", // Tailwind emerald-600
    classes: { text: "text-emerald-600", bar: "bg-emerald-600", chip: "bg-emerald-600/10 border-emerald-600/40" },
    rules: LOYAL_CUSTOMER_RULES,
    decay: LOYAL_CUSTOMER_DECAY,
    nudge: {
      headline: "Reward the relationship",
      directive: "Surface early access products. Show VIP badge. Offer referral program.",
      actions: ["Unlock early-access collection", "Display VIP status badge", "Offer refer-a-friend credit"],
    },
  },
});

/** Fixed display order for the five states (never re-sorted by rank). */
const STATE_ORDER = Object.freeze(["BROWSER", "COMPARER", "DISCOUNT_SEEKER", "CART_ABANDONER", "LOYAL_CUSTOMER"]);

// ═══════════════════════════════════════════════════════════════════════════
// 5. RULES ENGINE CORE — classifySession(events)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One evaluated rule, as rendered in the evidence panel. Signal rules carry a
 * positive (or zero) contribution; decay rules carry a negative contribution
 * equal to the confidence they removed.
 *
 * @typedef {Object} EvidenceItem
 * @property {string} rule
 * @property {number} weight        Signal rules: the rule's weight. Decay rules: the multiplier.
 * @property {number} contribution  Confidence points added (signal) or removed (decay)
 * @property {boolean} triggered
 * @property {string} explanation
 * @property {"signal"|"decay"} kind
 */

/**
 * Score of a single state against the feature vector.
 *
 * @typedef {Object} StateScore
 * @property {string} id
 * @property {number} confidence   0-100 after damping and decay
 * @property {EvidenceItem[]} evidence
 */

/**
 * Full engine output for a session.
 *
 * @typedef {Object} ClassificationResult
 * @property {?string} primary     Highest-confidence state id, null when no signal exists
 * @property {?string} secondary   Second state, only when its confidence >= SECONDARY_MIN_CONFIDENCE
 * @property {number} confidence   The primary state's confidence (0-100)
 * @property {EvidenceItem[]} evidence   Evidence for the primary state
 * @property {?Nudge} nudge
 * @property {FeatureVector} featureVector
 * @property {Record<string, number>} scores           Confidence per state id
 * @property {Record<string, EvidenceItem[]>} evidenceByState  Full evidence per state id
 */

/**
 * Evaluates one state's weighted rule set against a feature vector.
 *
 * Scoring model:
 *   base       = Σ(weight_i × score_i) / Σ(weight_i) × 100
 *   damped     = base × min(totalEvents / MIN_EVENTS_FOR_FULL_CONFIDENCE, 1)
 *   confidence = damped × Π(decay multipliers that apply)
 *
 * @param {ShopperState} state
 * @param {FeatureVector} features
 * @returns {StateScore}
 */
function scoreState(state, features) {
  const totalWeight = state.rules.reduce((sum, r) => sum + r.weight, 0);
  const damping = Math.min(features.totalEvents / MIN_EVENTS_FOR_FULL_CONFIDENCE, 1);

  /** @type {EvidenceItem[]} */
  const evidence = [];
  let confidence = 0;

  for (const rule of state.rules) {
    const score = clamp01(rule.evaluate(features));
    const contribution = (score * rule.weight * CONFIDENCE_MAX * damping) / totalWeight;
    confidence += contribution;
    evidence.push({
      rule: rule.rule,
      weight: rule.weight,
      contribution: round1(contribution),
      triggered: score >= RULE_TRIGGER_THRESHOLD,
      explanation: rule.explain(features),
      kind: "signal",
    });
  }

  for (const decay of state.decay) {
    const applies = decay.applies(features);
    const before = confidence;
    if (applies) confidence *= decay.multiplier;
    evidence.push({
      rule: decay.rule,
      weight: decay.multiplier,
      contribution: round1(confidence - before),
      triggered: applies,
      explanation: decay.explain(features),
      kind: "decay",
    });
  }

  return { id: state.id, confidence: round1(clamp01(confidence / CONFIDENCE_MAX) * CONFIDENCE_MAX), evidence };
}

/**
 * Classifies a shopper session from its raw event stream.
 *
 * Pure function: no side effects, no clock reads, no randomness. Fully
 * separable from React — feed it any chronologically ordered ShopperEvent[]
 * and it returns the same ClassificationResult every time.
 *
 * @param {ShopperEvent[]} events
 * @returns {ClassificationResult}
 */
function classifySession(events) {
  const featureVector = computeFeatures(events);
  const scored = STATE_ORDER.map((id) => scoreState(SHOPPER_STATES[id], featureVector));

  // Stable sort: on ties the earlier state in STATE_ORDER wins, so results
  // are deterministic.
  const ranked = [...scored].sort((a, b) => b.confidence - a.confidence);
  const hasSignal = events.length > 0 && ranked[0].confidence > 0;

  const primary = hasSignal ? ranked[0].id : null;
  const secondary = hasSignal && ranked[1].confidence >= SECONDARY_MIN_CONFIDENCE ? ranked[1].id : null;

  return {
    primary,
    secondary,
    confidence: hasSignal ? ranked[0].confidence : 0,
    evidence: hasSignal ? ranked[0].evidence : [],
    nudge: primary ? SHOPPER_STATES[primary].nudge : null,
    featureVector,
    scores: Object.fromEntries(scored.map((s) => [s.id, s.confidence])),
    evidenceByState: Object.fromEntries(scored.map((s) => [s.id, s.evidence])),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. SIMULATOR DATA — catalog, metadata generators, scenario presets
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A product in the demo catalog.
 * @typedef {Object} CatalogProduct
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {number} price
 */

/** @type {CatalogProduct[]} */
const CATALOG = [
  { id: "SKU-1001", name: "Aurora Running Shoes", category: "Footwear", price: 129 },
  { id: "SKU-1002", name: "Trailblazer Hiking Boots", category: "Footwear", price: 189 },
  { id: "SKU-1003", name: "Velocity Windbreaker", category: "Outerwear", price: 98 },
  { id: "SKU-1004", name: "Summit Puffer Jacket", category: "Outerwear", price: 240 },
  { id: "SKU-1005", name: "Pulse Wireless Earbuds", category: "Electronics", price: 149 },
  { id: "SKU-1006", name: "Nimbus Smart Watch", category: "Electronics", price: 299 },
  { id: "SKU-1007", name: "Harbor Canvas Tote", category: "Accessories", price: 59 },
  { id: "SKU-1008", name: "Atlas Leather Belt", category: "Accessories", price: 45 },
];

/** Distinct category names in the catalog. @type {string[]} */
const CATALOG_CATEGORIES = [...new Set(CATALOG.map((p) => p.category))];

/** Broad, exploratory queries (at most BROAD_QUERY_MAX_WORDS words). */
const BROAD_SEARCH_QUERIES = ["sale", "new arrivals", "gifts", "best sellers", "jackets"];

/** Specific, intent-loaded queries a decided shopper would type. */
const SPECIFIC_SEARCH_QUERIES = [
  "waterproof hiking boots size 10",
  "noise cancelling earbuds under 150",
  "mens leather belt 34 brown",
  "lightweight packable rain jacket",
];

/** Queries a coupon hunter would type. */
const COUPON_SEARCH_QUERIES = ["promo code", "discount code", "coupon 2026"];

/** Discount depths a coupon can grant, in percent. */
const COUPON_DISCOUNT_CHOICES = [10, 15, 20, 25];

/** Dwell-time range (seconds) for a randomly generated product view. */
const RANDOM_DWELL_MIN_S = 4;
const RANDOM_DWELL_MAX_S = 90;

/** Pick a uniformly random element. @template T @param {T[]} arr @returns {T} */
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Random integer in [min, max]. @param {number} min @param {number} max @returns {number} */
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * The product a cart/wishlist/price event should reference: the most recently
 * viewed product when one exists (a shopper carts what they just looked at),
 * otherwise a random catalog pick.
 *
 * @param {ShopperEvent[]} priorEvents
 * @returns {CatalogProduct}
 */
function contextProduct(priorEvents) {
  for (let i = priorEvents.length - 1; i >= 0; i -= 1) {
    const e = priorEvents[i];
    if (e.type === EVENT_TYPES.PRODUCT_VIEW && e.metadata?.productId) {
      const match = CATALOG.find((p) => p.id === e.metadata.productId);
      if (match) return match;
    }
  }
  return randomItem(CATALOG);
}

/** Compact metadata for a product-scoped event. @param {CatalogProduct} p @returns {EventMetadata} */
const productMetadata = (p) => ({ productId: p.id, productName: p.name, category: p.category, price: p.price });

/**
 * The discount that applies to a purchase happening now: the discountPercent
 * of the most recent COUPON_APPLIED since the last completed purchase, or 0
 * (full price) when none exists.
 *
 * @param {ShopperEvent[]} priorEvents
 * @returns {number}
 */
function activeDiscountPercent(priorEvents) {
  for (let i = priorEvents.length - 1; i >= 0; i -= 1) {
    const e = priorEvents[i];
    if (e.type === EVENT_TYPES.PURCHASE_COMPLETED) return 0;
    if (e.type === EVENT_TYPES.COUPON_APPLIED) return e.metadata?.discountPercent ?? 0;
  }
  return 0;
}

/**
 * Generates realistic metadata for a quick-fired event, using prior session
 * context where it matters (cart events reference the last viewed product,
 * purchases inherit an applied coupon's discount).
 *
 * @param {EventType} type
 * @param {ShopperEvent[]} priorEvents
 * @returns {EventMetadata|undefined}
 */
function generateMetadata(type, priorEvents) {
  switch (type) {
    case EVENT_TYPES.PRODUCT_VIEW: {
      const p = randomItem(CATALOG);
      return { ...productMetadata(p), timeOnPage: randomInt(RANDOM_DWELL_MIN_S, RANDOM_DWELL_MAX_S) };
    }
    case EVENT_TYPES.CATEGORY_VIEW:
      return { category: randomItem(CATALOG_CATEGORIES) };
    case EVENT_TYPES.FILTER_USED:
      return { category: contextProduct(priorEvents).category };
    case EVENT_TYPES.SEARCH:
      // Half the quick-fired searches are broad ("sale"), half specific —
      // so the button exercises both sides of the broad-search signal.
      return { searchQuery: Math.random() < 0.5 ? randomItem(BROAD_SEARCH_QUERIES) : randomItem(SPECIFIC_SEARCH_QUERIES) };
    case EVENT_TYPES.ADD_TO_CART:
    case EVENT_TYPES.REMOVE_FROM_CART:
    case EVENT_TYPES.WISHLIST_ADD:
    case EVENT_TYPES.PRICE_CHECK:
    case EVENT_TYPES.REVIEW_READ:
      return productMetadata(contextProduct(priorEvents));
    case EVENT_TYPES.COUPON_SEARCH:
      return { searchQuery: randomItem(COUPON_SEARCH_QUERIES) };
    case EVENT_TYPES.COUPON_APPLIED:
      return { discountPercent: randomItem(COUPON_DISCOUNT_CHOICES) };
    case EVENT_TYPES.CHECKOUT_STARTED:
    case EVENT_TYPES.CHECKOUT_ABANDONED:
      return { price: contextProduct(priorEvents).price };
    case EVENT_TYPES.PURCHASE_COMPLETED: {
      const p = contextProduct(priorEvents);
      return { ...productMetadata(p), discountPercent: activeDiscountPercent(priorEvents) };
    }
    default:
      return undefined; // PAGE_VIEW, RETURN_VISIT carry no metadata
  }
}

/**
 * Builds a complete quick-fire event stamped with the current time.
 *
 * @param {EventType} type
 * @param {ShopperEvent[]} priorEvents
 * @returns {ShopperEvent}
 */
function createEvent(type, priorEvents) {
  return {
    id: crypto.randomUUID(),
    type,
    timestamp: Date.now(),
    metadata: generateMetadata(type, priorEvents),
  };
}

/**
 * One step of a scenario preset. `atSec` is the offset from the scenario's
 * first event, so realistic gaps (a 60-second post-abandonment silence, a
 * 75-second product study) survive replay at any speed.
 *
 * @typedef {Object} PresetStep
 * @property {EventType} type
 * @property {number} atSec
 * @property {EventMetadata=} metadata
 */

/**
 * A pre-built session representing a classic shopper archetype.
 *
 * @typedef {Object} ScenarioPreset
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {string} archetype  State id this scenario is engineered to land on
 * @property {PresetStep[]} steps
 */

/** Shorthand for defining preset steps. @param {EventType} type @param {number} atSec @param {EventMetadata=} metadata @returns {PresetStep} */
const step = (type, atSec, metadata) => ({ type, atSec, ...(metadata ? { metadata } : {}) });

/** Metadata builder for preset product references. @param {string} skuId @param {number=} timeOnPage @returns {EventMetadata} */
const sku = (skuId, timeOnPage) => {
  const p = CATALOG.find((c) => c.id === skuId);
  return { ...productMetadata(p), ...(timeOnPage !== undefined ? { timeOnPage } : {}) };
};

/** @type {ScenarioPreset[]} */
const SCENARIO_PRESETS = [
  {
    id: "window-shopper",
    label: "Window Shopper",
    description: "Drifts across four categories, skims two products, never touches the cart.",
    archetype: "BROWSER",
    steps: [
      step(EVENT_TYPES.PAGE_VIEW, 0),
      step(EVENT_TYPES.CATEGORY_VIEW, 8, { category: "Footwear" }),
      step(EVENT_TYPES.PAGE_VIEW, 15),
      step(EVENT_TYPES.SEARCH, 22, { searchQuery: "sale" }),
      step(EVENT_TYPES.CATEGORY_VIEW, 30, { category: "Electronics" }),
      step(EVENT_TYPES.PRODUCT_VIEW, 38, sku("SKU-1005", 8)),
      step(EVENT_TYPES.PAGE_VIEW, 47),
      step(EVENT_TYPES.CATEGORY_VIEW, 55, { category: "Accessories" }),
      step(EVENT_TYPES.SEARCH, 64, { searchQuery: "gifts" }),
      step(EVENT_TYPES.PRODUCT_VIEW, 72, sku("SKU-1007", 6)),
    ],
  },
  {
    id: "methodical-comparer",
    label: "Methodical Comparer",
    description: "Three long looks at Footwear rivals, reviews, price checks, a wishlist save.",
    archetype: "COMPARER",
    steps: [
      step(EVENT_TYPES.SEARCH, 0, { searchQuery: "trail running shoes womens 8" }),
      step(EVENT_TYPES.CATEGORY_VIEW, 10, { category: "Footwear" }),
      step(EVENT_TYPES.FILTER_USED, 18, { category: "Footwear" }),
      step(EVENT_TYPES.PRODUCT_VIEW, 30, sku("SKU-1001", 75)),
      step(EVENT_TYPES.REVIEW_READ, 95, sku("SKU-1001")),
      step(EVENT_TYPES.PRODUCT_VIEW, 130, sku("SKU-1002", 88)),
      step(EVENT_TYPES.PRICE_CHECK, 150, sku("SKU-1002")),
      step(EVENT_TYPES.PRODUCT_VIEW, 170, sku("SKU-1001", 60)),
      step(EVENT_TYPES.WISHLIST_ADD, 200, sku("SKU-1001")),
      step(EVENT_TYPES.REVIEW_READ, 215, sku("SKU-1002")),
      step(EVENT_TYPES.PRICE_CHECK, 230, sku("SKU-1001")),
    ],
  },
  {
    id: "discount-hunter",
    label: "Discount Hunter",
    description: "Hunts codes before looking, applies one, drops the cart when the math disappoints.",
    archetype: "DISCOUNT_SEEKER",
    steps: [
      step(EVENT_TYPES.SEARCH, 0, { searchQuery: "promo code" }),
      step(EVENT_TYPES.COUPON_SEARCH, 10, { searchQuery: "promo code" }),
      step(EVENT_TYPES.PRODUCT_VIEW, 20, sku("SKU-1004", 25)),
      step(EVENT_TYPES.PRICE_CHECK, 45, sku("SKU-1004")),
      step(EVENT_TYPES.ADD_TO_CART, 55, sku("SKU-1004")),
      step(EVENT_TYPES.COUPON_SEARCH, 70, { searchQuery: "discount code" }),
      step(EVENT_TYPES.COUPON_APPLIED, 85, { discountPercent: 10 }),
      step(EVENT_TYPES.PRICE_CHECK, 95, sku("SKU-1004")),
      step(EVENT_TYPES.REMOVE_FROM_CART, 105, sku("SKU-1004")),
      step(EVENT_TYPES.RETURN_VISIT, 160),
      step(EVENT_TYPES.COUPON_SEARCH, 170, { searchQuery: "coupon 2026" }),
    ],
  },
  {
    id: "abandoned-checkout",
    label: "Abandoned Checkout",
    description: "Carts a smart watch, starts checkout, walks away, returns but never re-commits.",
    archetype: "CART_ABANDONER",
    steps: [
      step(EVENT_TYPES.PAGE_VIEW, 0),
      step(EVENT_TYPES.PRODUCT_VIEW, 10, sku("SKU-1006", 40)),
      step(EVENT_TYPES.PRODUCT_VIEW, 60, sku("SKU-1005", 35)),
      step(EVENT_TYPES.ADD_TO_CART, 95, sku("SKU-1006")),
      step(EVENT_TYPES.PAGE_VIEW, 105),
      step(EVENT_TYPES.CHECKOUT_STARTED, 115, { price: 299 }),
      step(EVENT_TYPES.CHECKOUT_ABANDONED, 150, { price: 299 }),
      step(EVENT_TYPES.RETURN_VISIT, 210), // 60s of silence after walking away
      step(EVENT_TYPES.PRODUCT_VIEW, 220, sku("SKU-1006", 20)),
      step(EVENT_TYPES.PAGE_VIEW, 240),
    ],
  },
  {
    id: "loyal-repeat-buyer",
    label: "Loyal Repeat Buyer",
    description: "Returns, buys at full price, reads reviews after, then buys again.",
    archetype: "LOYAL_CUSTOMER",
    steps: [
      step(EVENT_TYPES.RETURN_VISIT, 0),
      step(EVENT_TYPES.PRODUCT_VIEW, 8, sku("SKU-1008", 30)),
      step(EVENT_TYPES.ADD_TO_CART, 25, sku("SKU-1008")),
      step(EVENT_TYPES.CHECKOUT_STARTED, 35, { price: 45 }),
      step(EVENT_TYPES.PURCHASE_COMPLETED, 50, { ...sku("SKU-1008"), discountPercent: 0 }),
      step(EVENT_TYPES.RETURN_VISIT, 110),
      step(EVENT_TYPES.REVIEW_READ, 120, sku("SKU-1008")),
      step(EVENT_TYPES.PRODUCT_VIEW, 135, sku("SKU-1007", 25)),
      step(EVENT_TYPES.ADD_TO_CART, 150, sku("SKU-1007")),
      step(EVENT_TYPES.CHECKOUT_STARTED, 158, { price: 59 }),
      step(EVENT_TYPES.PURCHASE_COMPLETED, 170, { ...sku("SKU-1007"), discountPercent: 0 }),
    ],
  },
];

/**
 * Materialises a preset into concrete events. Timestamps are rebased so the
 * scenario's last step lands at "now" — earlier steps sit in the recent past,
 * preserving the scenario's realistic time gaps for the engine's idle and
 * quick-purchase detection.
 *
 * @param {ScenarioPreset} preset
 * @returns {ShopperEvent[]}
 */
function materializePreset(preset) {
  const lastAtSec = preset.steps[preset.steps.length - 1].atSec;
  const base = Date.now() - lastAtSec * 1000;
  return preset.steps.map((s) => ({
    id: crypto.randomUUID(),
    type: s.type,
    timestamp: base + s.atSec * 1000,
    ...(s.metadata ? { metadata: s.metadata } : {}),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. UI — placeholder shell (simulator, output and evidence panels land in
//    the next iterations of this file).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Root component. Placeholder until the simulator and dashboard UI land.
 * @returns {JSX.Element}
 */
export default function PersonalizationRulesEngine() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center font-sans">
      <p className="text-slate-400">StoreIQ rules engine core loaded — UI arriving in the next commit.</p>
    </div>
  );
}
