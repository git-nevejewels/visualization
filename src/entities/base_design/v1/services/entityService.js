// src/entities/base_design/v1/services/entityService.js
//
// READ-ONLY, molded into Visualization's own response shape from THREE different sources — see
// ARCHITECTURE.md/GAPS.md/RULES.md for the full trail:
//
// - base_design's own fields (basicInformation/metalConfig/stoneConfig) are fetched from
//   Merchandising's own API (added 2026-09-15 — it now owns this entity for real: its own
//   Sequelize model, ID generation, schema validation, history). NEVER read the base_design table
//   directly here — that duplicated logic Merchandising now properly owns. This is a direct
//   service-to-service HTTP call, NOT routed through the BFF (this isn't a frontend-initiated
//   action). We call Merchandising for the raw data and MOLD it into our own response shape here
//   (axisNames/stoneTypes/metalColourBreakdown/existingRequests/dimensionalFeatures/stoneFeatures)
//   — callers get one Visualization response, not Merchandising's shape passed through untouched.
// - component_set is read via raw, parameterized SQL against the shared connection —
//   D:\work\cad's own component_set API can't serve this (checked: its filterQuery has the same
//   Sequelize.literal-as-object-key bug fixed in this repo's own image_request/variant_task, and
//   its one specialized endpoint needs designRequestId, which is empty for base_design-sourced
//   rows). No Sequelize model is ever defined for component_set — nothing here ever writes to it.
// - stone_template (Quality/Colour/Clarity/etc. feature values for a resolved stone team) is
//   fetched from MDM's own API (added 2026-09-15), by the templateId already persisted on
//   base_design's own stoneConfig.stoneTeams[].teamDetails[] — resolved once, at authoring time,
//   by MDM's own resolve/resolve-batch endpoints (see D:\work\PIM\script\utils\
//   resolveStoneTemplates.js). Visualization only ever reads a template that's already been
//   picked; it never calls resolve/resolve-batch itself.

const mainConfig = require('../../../../../config/config');
const defaultSequelize = require('../../../../common/v1/db/sequelize');
const { executeOperation } = require('../../../../../utils/queryExecutor');
const logger = require('../../../../common/v1/utils/logger');
const { fetchJson } = require('../../../../common/v1/utils/httpClient');

// --------------------
// Merchandising client — plain fetch via the shared httpClient (see src/common/v1/utils/
// httpClient.js — extracted once image_request's own module needed the same call for its
// dashboard/getByStats enrichment; each entity still keeps its own URL builder, since the resource
// path differs per caller).
// --------------------
function merchandisingUrl(path) {
  if (!mainConfig.urls.merchandising) {
    throw new Error('MERCHANDISING url is not configured (see .env / config/config.js urls.merchandising)');
  }
  return `${mainConfig.urls.merchandising}/api/base_design/v1${path}`;
}

// --------------------
// MDM client — owns stone_template. base_design's own stoneConfig.stoneTeams[].teamDetails[]
// already carries a resolved `templateId` (attached once, at authoring time, by MDM's own
// resolve/resolve-batch endpoints — see D:\work\PIM\script\utils\resolveStoneTemplates.js).
// Visualization never resolves a template itself; it only reads the one already picked, by id.
// --------------------
function mdmUrl(path) {
  if (!mainConfig.urls.mdm) {
    throw new Error('MDM url is not configured (see .env / config/config.js urls.mdm)');
  }
  return `${mainConfig.urls.mdm}/api/stone_template/v1${path}`;
}

// Per-id cache, not stale-while-revalidate like fetchAllBaseDesigns below — stone_template is
// reference data too, but only the handful of distinct templateIds one base_design's own
// stoneTeams actually reference are ever fetched, so a cache miss costs one cheap single-row GET,
// never a multi-second full-catalog fetch. A plain TTL is enough here.
const STONE_TEMPLATE_CACHE_TTL_MS = 5 * 60_000;
const stoneTemplateCache = new Map(); // templateId -> { data, fetchedAt }

async function fetchStoneTemplate(templateId, logContext = {}) {
  const cached = stoneTemplateCache.get(templateId);
  if (cached && (Date.now() - cached.fetchedAt) < STONE_TEMPLATE_CACHE_TTL_MS) return cached.data;

  let body;
  try {
    body = await fetchJson(mdmUrl(`/${templateId}`), logContext);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
  const data = body.data || null;
  if (data) stoneTemplateCache.set(templateId, { data, fetchedAt: Date.now() });
  return data;
}

// NOTE: Merchandising's own `fields=` projection (buildSelectedAttributes -> Sequelize.json) can
// only project paths INSIDE base_design_details — it replaces the attribute list entirely and has
// no way to also ask for the base_design_id primary key column alongside it. Confirmed by reading
// Merchandising's own entityService.js: a field-projected row never carries the id. So the list
// fetch below deliberately does NOT pass `fields=` — it takes full rows (id + full details) and
// this module does its own trimming in mapRow(). The one-time cost of a full ~1,100-row fetch is
// paid only on cache refresh, in the background (see fetchAllBaseDesigns below), never inline on a
// request — so there's no real payoff left for field-projection once caching is in place anyway.
function mapRow(row) {
  const details = row.base_design_details || {};
  const basicInformation = details.basicInformation || {};
  return {
    baseDesignId: row.base_design_id,
    ornamentName: basicInformation.ornamentName,
    referenceDesignName: basicInformation.referenceDesignName,
    category: basicInformation.category,
    subCategory: basicInformation.subCategory,
    intendedFor: basicInformation.intendedFor,
    collectionNumber: basicInformation.collectionNumber,
    collectionPrefix: basicInformation.collectionPrefix,
    metalTeams: details.metalConfig?.metalTeams || [],
    metalOptions: details.metalConfig?.metalOptions || [],
    stoneTeams: details.stoneConfig?.stoneTeams || [],
  };
}

// --------------------
// Stale-while-revalidate cache for "every base_design, projected+mapped" — found NECESSARY, not
// optional, via testing (see GAPS.md): even with field projection, fetching ~1,100 rows over HTTP
// takes multiple seconds. base_design is master/reference data (the user's own description) that
// changes rarely, so caching is the right tool — but a plain TTL cache still makes ONE unlucky
// request pay the full refresh cost whenever it expires. Stale-while-revalidate avoids that
// entirely after the very first call: serve whatever's cached immediately (even if past TTL),
// and kick off a background refresh — no request-facing code ever awaits the Merchandising round
// trip except the actual first call after server start (nothing to serve yet).
// --------------------
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes
let baseDesignCache = { data: null, fetchedAt: 0 };
let refreshInFlight = null;

// Deliberately does NOT forward a correlationId to fetchJson — unlike every other outbound call in
// this file, this refresh is a SHARED background operation with no single owning request: the
// stale-while-revalidate refresh it triggers may be kicked off by one request but its result gets
// served to many others already in flight, and the very first cold-start call similarly has no
// natural "this one request" to attribute the trace to. Attaching one caller's correlationId here
// would misrepresent the trace, not complete it.
async function refreshBaseDesignCache() {
  const merchResponse = await fetchJson(merchandisingUrl('?pageNumber=1&batchSize=5000'));
  const allDesigns = (merchResponse.data || []).map(mapRow);
  baseDesignCache = { data: allDesigns, fetchedAt: Date.now() };
  return allDesigns;
}

async function fetchAllBaseDesigns() {
  const now = Date.now();
  const isFresh = baseDesignCache.data && (now - baseDesignCache.fetchedAt) < CACHE_TTL_MS;
  if (isFresh) return baseDesignCache.data;

  if (baseDesignCache.data) {
    if (!refreshInFlight) {
      refreshInFlight = refreshBaseDesignCache()
        .catch(err => {
          logger.warn({
            message: `base_design cache background refresh failed, keeping stale data: ${err.message}`,
            messageType: 'EVENT',
            processName: 'RefreshBaseDesignCache',
          });
        })
        .finally(() => { refreshInFlight = null; });
    }
    return baseDesignCache.data; // serve stale immediately, refresh continues in the background
  }

  // No cache at all yet (first call since server start) — nothing to serve, must wait.
  if (!refreshInFlight) {
    refreshInFlight = refreshBaseDesignCache().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// --------------------
// Metal colour classification — user's rule (2026-09-15, confirmed explicitly, not guessed):
// Platinum, Silver, and White Gold -> white; Rose Gold -> rose; every other gold type
// (Yellow Gold, and anything else without an explicit colour word) -> yellow. Matches the same
// substring-classification technique the wireframe itself used (COLOUR_GROUPS/groupOf()), just
// applied to real metalOptions data instead of a hardcoded mock list.
// MIXED METALS (isMixMetal: true, e.g. "18K White Gold Shank/Platinum (950) Head") are
// deliberately EXCLUDED from this breakdown for now — the wireframe's own model never accounted
// for them, and the user has not yet given a rule for how to bucket one. Revisit when they do —
// see GAPS.md.
// --------------------
function classifyMetalColour(metalName) {
  const lower = (metalName || '').toLowerCase();
  if (lower.includes('platinum') || lower.includes('silver') || lower.includes('white')) return 'white';
  if (lower.includes('rose')) return 'rose';
  return 'yellow';
}

function deriveMetalColourBreakdown(metalOptions = []) {
  const breakdown = { white: 0, yellow: 0, rose: 0 };
  for (const opt of metalOptions) {
    if (opt.isMixMetal) continue; // excluded — see comment above
    breakdown[classifyMetalColour(opt.metalName)]++;
  }
  return breakdown;
}

// Distinct DIMENSIONAL axis names this base_design varies by — e.g. "Ring Size", "Band Width".
// Derived from metalConfig.metalTeams[].teamDetails[].featureName, deduped, in first-seen order.
function deriveAxisNames(metalTeams = []) {
  const seen = new Set();
  const axes = [];
  for (const team of metalTeams) {
    for (const detail of team.teamDetails || []) {
      if (detail.featureName && !seen.has(detail.featureName)) {
        seen.add(detail.featureName);
        axes.push(detail.featureName);
      }
    }
  }
  return axes;
}

// Distinct stone types this base_design offers — e.g. "Natural Diamond". Derived from
// stoneConfig.stoneTeams[].teamDetails[].stoneType (NOTE: real data field is "stoneTeams",
// plural — the design_request reference schema this was based on says "stoneTeam", singular;
// confirmed by querying a real row that real data uses the plural form).
function deriveStoneTypes(stoneTeams = []) {
  const seen = new Set();
  const types = [];
  for (const team of stoneTeams) {
    for (const detail of team.teamDetails || []) {
      if (detail.stoneType && !seen.has(detail.stoneType)) {
        seen.add(detail.stoneType);
        types.push(detail.stoneType);
      }
    }
  }
  return types;
}

// Selectable metal-side features with their real values — e.g. { featureName: "Ring Size",
// values: [{valueCode,valueText}, ...] }. THREE different sourcing rules, manager/user-confirmed
// 2026-09-16 (see GAPS.md):
//
// - Ring Size is an EXPLICIT, DELIBERATE EXCEPTION (user decision 2026-09-16): even though it IS a
//   team-forming dimensional feature (baked into metalTeamCode same as Band Width), it always shows
//   its FULL range from base_design's own catalog, never filtered to what's been produced —
//   business reasoning given: a request can pick any ring size; production isn't limited to sizes
//   already made. Matched by `legacyFeature === 'ring_size'`, not by display name (names can be
//   localized/renamed; the legacy code is the stable identifier).
// - Every OTHER team-forming feature (`isDimensional: true` — Band Width, Band Depth, Width) gets
//   its values filtered down to only what's actually been PRODUCED: `producedMetalTeams` (passed
//   in by getOptions, already cross-referenced against component_set's own DISTINCT metalTeamIds
//   for this base_design) is unioned across each produced team's own `teamDetails`. A value that
//   only exists on a team nobody has ever produced never appears — "options come from
//   component_set," applied at the VALUE level, not just the pair level.
// - NON-team features (`isDimensional: false` but `affectsImage: true` — e.g. "Band Finish") are
//   NOT filtered by component_set either — they're never encoded into `metalTeamCode` in the first
//   place (confirmed: no team's own teamDetails ever carries one of these), so component_set has no
//   opinion on them at all. base_design's own `metalFeatures` catalog is authoritative, unfiltered.
// Certificate stays excluded throughout — real data confirms it carries BOTH `isDimensional:false`
// AND `affectsImage:false`, so it never qualifies for any of the three buckets above. Never derive
// any bucket from a specific-featureName list (besides the one deliberate Ring Size exception) — it
// would silently miss the next feature PIM adds the same way.
const RING_SIZE_LEGACY_FEATURE = 'ring_size';

function deriveDimensionalFeatures(metalFeatures = [], producedMetalTeams = []) {
  const teamFormingValuesByFeature = new Map(); // featureName -> Map(valueCode -> valueText)
  for (const team of producedMetalTeams) {
    for (const d of team.teamDetails || []) {
      if (!d.featureName) continue;
      if (!teamFormingValuesByFeature.has(d.featureName)) teamFormingValuesByFeature.set(d.featureName, new Map());
      teamFormingValuesByFeature.get(d.featureName).set(d.valueCode, d.valueText);
    }
  }

  const results = [];
  for (const f of metalFeatures) {
    if (!f.isDimensional && !f.affectsImage) continue; // Certificate etc. — never included

    if (f.legacyFeature === RING_SIZE_LEGACY_FEATURE || !f.isDimensional) {
      // Ring Size exception, or a non-team affectsImage feature (Band Finish) — full catalog, unfiltered.
      results.push({
        featureName: f.featureName,
        legacyFeature: f.legacyFeature,
        isDimensional: !!f.isDimensional,
        values: (f.values || []).map(v => ({ valueCode: v.valueCode, valueText: v.valueText })),
      });
      continue;
    }

    // Every other team-forming feature — filtered to what's actually been produced.
    const valueMap = teamFormingValuesByFeature.get(f.featureName);
    if (!valueMap) continue; // nothing produced carries this feature at all
    results.push({
      featureName: f.featureName,
      legacyFeature: f.legacyFeature,
      isDimensional: true,
      values: [...valueMap.entries()].map(([valueCode, valueText]) => ({ valueCode, valueText })),
    });
  }
  return results;
}

// Non-dimensional STONE feature values (Quality/Colour/Clarity/Cut Grade/Polish/Symmetry/
// Fluorescence — informational, never affects which componentSetId matches) for the given list of
// stone_template ids (a scoped caller passes only the 1-2 templateIds an actual chosen stoneTeamId
// references — see getOptions below; a base_design as a whole can carry a dozen+ distinct templates
// across all its stone teams, far more than any single "raise request" screen needs at once).
// Certificate is deliberately dropped from every template's features — explicit user decision
// (2026-09-15): no image is ever produced differently based on Certificate, so it has no reason to
// appear in an image-request options response.
async function fetchStoneFeaturesByTemplateId(templateIds = [], logContext = {}) {
  const ids = [...new Set(templateIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const templates = await Promise.all(
    ids.map(async templateId => ({ templateId, template: await fetchStoneTemplate(templateId, logContext) }))
  );

  return templates
    .filter(t => t.template)
    .map(({ templateId, template }) => {
      const details = template.stone_template_details || {};
      return {
        templateId,
        templateName: details.templateName,
        stoneType: details.applicability?.stoneType,
        positions: details.applicability?.positions || [],
        features: (details.features || [])
          .filter(f => f.featureName !== 'Certificate')
          .map(f => ({
            featureName: f.featureName,
            values: (f.values || []).map(v => ({ valueCode: v.valueCode, valueText: v.valueText })),
          })),
      };
    });
}

// GET / — list/search, for the Raise Request page. Search/pagination happen locally (Merchandising's
// own search/filterQuery can't reach nested basicInformation fields any more cleanly than ours
// could before our own fix, so there's no benefit to deferring to their side).
//
// Component_set-derived counts/existing-requests are scoped to just the current page — since the
// page is defined by an in-memory filter+sort (not SQL), ids are inlined as SAFELY ESCAPED SQL
// LITERALS (via sequelize.escape(), never a bound array replacement) — Postgres picks a much
// worse plan for a bound array parameter than for literal values in the same IN (...) clause
// (confirmed: 531ms vs 4ms for the identical query) — see RULES.md.
async function getAll(page = 1, pageSize = 20, search = '', logContext = {}) {
  return executeOperation(
    async () => {
      const allDesigns = await fetchAllBaseDesigns();

      const term = search ? search.toLowerCase() : null;
      const filtered = term
        ? allDesigns.filter(d =>
            (d.ornamentName || '').toLowerCase().includes(term) ||
            (d.referenceDesignName || '').toLowerCase().includes(term) ||
            (d.collectionNumber || '').toLowerCase().includes(term) ||
            d.baseDesignId.toLowerCase().includes(term))
        : allDesigns;

      filtered.sort((a, b) => a.baseDesignId.localeCompare(b.baseDesignId));
      const count = filtered.length;
      const pageRows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

      let countsByBaseDesignId = {};
      let existingRequestsByBaseDesignId = {};

      if (pageRows.length > 0) {
        const idList = pageRows.map(r => defaultSequelize.escape(r.baseDesignId)).join(',');

        const countRows = await defaultSequelize.query(
          `SELECT
             bd_ids.id AS "baseDesignId",
             COUNT(cs.component_set_id) AS "variantCount",
             COUNT(DISTINCT NULLIF(cs.component_set_details->>'metalTeamId', '')) AS "metalTeamCount",
             COUNT(DISTINCT NULLIF(cs.component_set_details->>'stoneTeamId', '')) AS "stoneTeamCount"
           FROM (VALUES ${pageRows.map(r => `(${defaultSequelize.escape(r.baseDesignId)})`).join(',')}) AS bd_ids(id)
           LEFT JOIN component_set cs ON cs.component_set_details->>'baseDesignId' = bd_ids.id
           GROUP BY bd_ids.id`,
          { type: defaultSequelize.QueryTypes.SELECT }
        );
        countsByBaseDesignId = Object.fromEntries(countRows.map(r => [r.baseDesignId, r]));

        const existingRequestRows = await defaultSequelize.query(
          `SELECT image_request_id AS "imageRequestId", image_request_details AS "imageRequestDetails"
           FROM image_request
           WHERE image_request_details->>'baseDesignId' IN (${idList})`,
          { type: defaultSequelize.QueryTypes.SELECT }
        );
        for (const r of existingRequestRows) {
          const bdId = r.imageRequestDetails?.baseDesignId;
          const variantCount = Array.isArray(r.imageRequestDetails?.requestedVariants)
            ? r.imageRequestDetails.requestedVariants.length : 0;
          (existingRequestsByBaseDesignId[bdId] = existingRequestsByBaseDesignId[bdId] || [])
            .push({ imageRequestId: r.imageRequestId, variantCount });
        }
      }

      const enriched = pageRows.map(r => {
        const counts = countsByBaseDesignId[r.baseDesignId] || { variantCount: 0, metalTeamCount: 0, stoneTeamCount: 0 };
        return {
          baseDesignId: r.baseDesignId,
          ornamentName: r.ornamentName,
          referenceDesignName: r.referenceDesignName,
          category: r.category,
          subCategory: r.subCategory,
          intendedFor: r.intendedFor,
          collectionNumber: r.collectionNumber,
          collectionPrefix: r.collectionPrefix,
          variantCount: counts.variantCount,
          metalTeamCount: counts.metalTeamCount,
          stoneTeamCount: counts.stoneTeamCount,
          axisNames: deriveAxisNames(r.metalTeams),
          stoneTypes: deriveStoneTypes(r.stoneTeams),
          metalColourBreakdown: deriveMetalColourBreakdown(r.metalOptions),
          existingRequests: existingRequestsByBaseDesignId[r.baseDesignId] || [],
        };
      });

      return { rows: enriched, count };
    },
    {
      processName: logContext.processName || 'GetAll_base_design',
      correlationId: logContext.correlationId,
      metadata: { page, pageSize },
    }
  );
}

// GET /:id — full base_design detail, molded the same way as getAll's rows (plus options, since a
// detail page needs everything in one call) — straight from Merchandising for the base fields
// (full details, not field-projected — it's a single row, cheap regardless), enriched from
// component_set and our own image_request the same way.
async function getById(id, logContext = {}) {
  return executeOperation(
    async () => {
      let body;
      try {
        body = await fetchJson(merchandisingUrl(`/${id}`), logContext);
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      const row = body.data;
      if (!row) return null;

      const details = row.base_design_details || {};
      const basicInformation = details.basicInformation || {};

      const [countRow] = await defaultSequelize.query(
        `SELECT
           COUNT(cs.component_set_id) AS "variantCount",
           COUNT(DISTINCT NULLIF(cs.component_set_details->>'metalTeamId', '')) AS "metalTeamCount",
           COUNT(DISTINCT NULLIF(cs.component_set_details->>'stoneTeamId', '')) AS "stoneTeamCount"
         FROM component_set cs WHERE cs.component_set_details->>'baseDesignId' = :id`,
        { replacements: { id }, type: defaultSequelize.QueryTypes.SELECT }
      );

      const existingRequestRows = await defaultSequelize.query(
        `SELECT image_request_id AS "imageRequestId", image_request_details AS "imageRequestDetails"
         FROM image_request WHERE image_request_details->>'baseDesignId' = :id`,
        { replacements: { id }, type: defaultSequelize.QueryTypes.SELECT }
      );
      const existingRequests = existingRequestRows.map(r => ({
        imageRequestId: r.imageRequestId,
        variantCount: Array.isArray(r.imageRequestDetails?.requestedVariants)
          ? r.imageRequestDetails.requestedVariants.length : 0,
      }));

      return {
        baseDesignId: row.base_design_id,
        ornamentName: basicInformation.ornamentName,
        referenceDesignName: basicInformation.referenceDesignName,
        category: basicInformation.category,
        subCategory: basicInformation.subCategory,
        intendedFor: basicInformation.intendedFor,
        collectionNumber: basicInformation.collectionNumber,
        collectionPrefix: basicInformation.collectionPrefix,
        variantCount: countRow.variantCount,
        metalTeamCount: countRow.metalTeamCount,
        stoneTeamCount: countRow.stoneTeamCount,
        axisNames: deriveAxisNames(details.metalConfig?.metalTeams),
        stoneTypes: deriveStoneTypes(details.stoneConfig?.stoneTeams),
        metalColourBreakdown: deriveMetalColourBreakdown(details.metalConfig?.metalOptions),
        existingRequests,
      };
    },
    {
      processName: logContext.processName || 'GetById_base_design',
      correlationId: logContext.correlationId,
      metadata: { id },
    }
  );
}

// Stone Type values, each carrying its own NESTED list of valid Shapes — deliberate exception
// (user decision 2026-09-16, same reasoning as Ring Size): sourced from base_design's FULL
// stoneTeams catalog, NOT filtered to what's been produced in component_set. Reasoning: unlike a
// flat cross-product of "any Stone Type x any Shape," each stoneTeamId maps to exactly ONE
// (stoneType, shape) pair (confirmed on real data — see RULES.md) — e.g. "Natural Black Diamond"
// only ever pairs with "Round". Nesting Shape under Stone Type is how the frontend avoids ever
// offering an invalid combination (like Black Diamond + Princess) that has no stoneTeam at all,
// without needing a separate available:true/false flag on every value. The final "has this actually
// been produced" check still happens later, at match-component-set time — this is purely about
// which combinations are even THEORETICALLY valid to pick.
//
// Each shape entry also carries its own resolved stoneTeamId/stoneTeamCode (added 2026-09-21) —
// mirrors D:\work\cad's own pdp v2 entity, which never resolves a stone team from stoneType+shape
// TEXT at all: its SKU URL already carries the team code directly (`ST0300`), parsed by
// `skuParser.js` and looked up with a plain `.find(t => t.teamCode === code)` (see
// resolveSkuSelection.js's `resolveStoneTeamByCode`). Since the (stoneType, shape) -> team mapping
// is already 1:1 and known here, exposing the code lets the caller do that same direct lookup
// itself (via `?stoneTeamId=...` below) instead of asking this endpoint to re-resolve it from text
// on a second round trip.
function deriveStoneAxisValues(stoneTeams = []) {
  const shapesByStoneType = new Map(); // stoneType -> Map(shape -> team)
  for (const team of stoneTeams) {
    // The CAPTAIN detail is the one that actually identifies this team's (stoneType, shape) —
    // side-stone details on the same team can carry their own, different stoneType/shape values
    // (e.g. Natural Diamond side stones on a Natural Moissanite team) and would misattribute the
    // team if not excluded.
    const captainDetail = (team.teamDetails || []).find(d => d.isCaptain);
    if (!captainDetail?.stoneType || !captainDetail?.shape) continue;
    if (!shapesByStoneType.has(captainDetail.stoneType)) shapesByStoneType.set(captainDetail.stoneType, new Map());
    shapesByStoneType.get(captainDetail.stoneType).set(captainDetail.shape, team);
  }
  return [...shapesByStoneType.entries()].map(([stoneType, shapeMap]) => ({
    valueText: stoneType,
    shapes: [...shapeMap.entries()].map(([shape, team]) => ({
      valueText: shape,
      stoneTeamId: team.teamId,
      stoneTeamCode: team.teamCode,
    })),
  }));
}

// Flattens every source into ONE flat options[] array — mirrors D:\work\cad's own pdp entity's
// `options[]` shape (tagged `partOf`), minus `renderAs`/`isSelected` (dropped 2026-09-16: this
// screen has no default selection to mark, and how to render a value is a frontend concern, not
// ours). `partOf` groups: MT (metal-side, team-forming or image-affecting — see
// deriveDimensionalFeatures), ST (Stone Type / Shape — independent picks, not team-scoped), SF
// (stone_template quality features — Certificate always excluded), CT (Carat/Size).
function buildOptionsList({ metalFeatures, producedMetalTeams, allStoneTeams, stoneFeatureGroups, caratOptions, sizeOptions }) {
  const options = [];

  for (const f of deriveDimensionalFeatures(metalFeatures, producedMetalTeams)) {
    options.push({ featureId: f.legacyFeature, name: f.featureName, partOf: 'MT', values: f.values });
  }

  const stoneTypes = deriveStoneAxisValues(allStoneTeams);
  if (stoneTypes.length) options.push({ featureId: 'stone_type', name: 'Stone Type', partOf: 'ST', values: stoneTypes });

  for (const group of stoneFeatureGroups) {
    for (const f of group.features) {
      options.push({ featureId: f.featureName.toLowerCase().replace(/\s+/g, '_'), name: f.featureName, partOf: 'SF', values: f.values });
    }
  }

  if (caratOptions?.length) options.push({ featureId: 'carat', name: 'Carat', partOf: 'CT', values: caratOptions.map(v => ({ valueText: v })) });
  if (sizeOptions?.length) options.push({ featureId: 'size', name: 'Size', partOf: 'CT', values: sizeOptions.map(v => ({ valueText: v })) });

  return options;
}

// Resolves which PRODUCED metal team a full metalSelections map matches, accounting for Ring
// Size's exemption from production-filtering (see deriveDimensionalFeatures/RULES.md). Ring Size
// doesn't need its own component_set row per size — resizing doesn't change the geometry — so ONE
// produced row's own `supportedMetalTeamCodes` (found on component_set, NOT base_design) covers a
// whole RANGE of Ring Size variants. Mirrors PDP's own `resolveBaseMetalTeam` fallback (see GAPS.md):
//   1. Fast path: a produced team whose OWN canonical Ring Size already equals the selection —
//      exact match on every feature, same as every other MT feature.
//   2. Fallback: for each produced team matching every OTHER feature (ignoring Ring Size), read
//      that team's own produced component_set row's `supportedMetalTeamCodes`. The Ring Size code
//      segment length is taken from the CANDIDATE'S OWN known-correct Ring Size valueCode (never a
//      guessed/hardcoded split) — strip that many characters off each supported code's end and
//      compare directly against the user's selected Ring Size CODE. This never assumes a
//      concatenation order or recipe — it only reads real, already-stored codes.
//
// Matches on valueCode, not valueText (changed 2026-09-21 — optimization: the frontend already has
// each pill's valueCode from the /options response it rendered the pill from, so it can send that
// straight back instead of the display label — same reliability, since valueCode already verified
// consistent per (featureName, valueCode) across every real base_design checked, just a shorter/
// cheaper string to carry and compare).
function resolveMetalTeamForRingSize(producedMetalTeams, metalFeatures, metalSelections) {
  const ringSizeFeature = metalFeatures.find(f => f.legacyFeature === RING_SIZE_LEGACY_FEATURE);
  const ringSizeFeatureName = ringSizeFeature?.featureName;
  const selectedRingSizeCode = ringSizeFeatureName ? metalSelections[ringSizeFeatureName] : undefined;

  const otherSelections = { ...metalSelections };
  if (ringSizeFeatureName) delete otherSelections[ringSizeFeatureName];

  const candidates = producedMetalTeams.filter(t => {
    const teamValues = new Map((t.teamDetails || []).map(d => [d.featureName, d.valueCode]));
    return Object.entries(otherSelections).every(([featureName, valueCode]) => teamValues.get(featureName) === valueCode);
  });

  if (!selectedRingSizeCode) return candidates[0] || null;

  const exact = candidates.find(t => (t.teamDetails || []).some(d => d.featureName === ringSizeFeatureName && d.valueCode === selectedRingSizeCode));
  if (exact) return exact;

  for (const candidate of candidates) {
    const ownRingSizeDetail = (candidate.teamDetails || []).find(d => d.featureName === ringSizeFeatureName);
    if (!ownRingSizeDetail?.valueCode) continue;

    // supportedMetalTeamCodes is already ON the team object itself (base_design's own metalTeams
    // response) — no DB round trip needed to read it. Mirrors D:\work\cad's pdp v2 entity's own
    // resolveBaseMetalTeam() (resolveSkuSelection.js), which resolves the exact same kind of
    // "covering team" fallback purely in-memory off `t.supportedMetalTeamCodes`, never a query.
    // Previously this queried `component_set` directly for the same data — confirmed redundant
    // 2026-09-21, since it's already denormalized onto the team object we already have in hand.
    const supportedCodes = candidate.supportedMetalTeamCodes || [];
    const suffixLength = ownRingSizeDetail.valueCode.length;
    const covers = supportedCodes.some(code => String(code).replace(/^MT/, '').slice(-suffixLength) === selectedRingSizeCode);
    if (covers) return candidate;
  }

  return null;
}

// GET /:id/options — the PRODUCIBLE feature catalog for a "raise request" screen, as ONE flat list
// (see buildOptionsList). Manager-confirmed 2026-09-16 (see GAPS.md): MT/ST values must come from
// `component_set` — NOT base_design's own full theoretical catalog. Mechanism:
//   1. Query component_set for the DISTINCT metalTeamId/stoneTeamId actually produced for this
//      base_design (component_set knows WHICH teams exist).
//   2. Cross-reference those ids against base_design's own metalTeams[]/stoneTeams[] (base_design
//      knows WHAT each team is made of — its teamDetails).
//   3. Union the values across only those PRODUCED teams — a value that only exists on a
//      never-produced team (e.g. a Ring Size, or a Shape like the wireframe's disabled "Oval",
//      with zero component_set rows) never appears at all.
// The one exception: non-team `affectsImage` metal features (e.g. "Band Finish") are NEVER
// filtered this way — they're not encoded into metalTeamCode in the first place, so component_set
// has no opinion on them; base_design's own catalog is authoritative (see deriveDimensionalFeatures).
//
// Pass `scope.stoneTeamId` (one Stone Type + Shape pick, already resolved by the caller straight
// off this same endpoint's own unscoped `stone_type` group — see deriveStoneAxisValues) to
// additionally resolve that one PRODUCED stone team's own SF (stone_template quality features,
// Certificate excluded) and CT (carat/size) groups — same "don't dump a dozen+ templates up front"
// principle as before. Changed 2026-09-21 from `stoneType`+`shape` TEXT params to a single
// `stoneTeamId` — mirrors D:\work\cad's own pdp v2 entity, which never resolves a stone team from
// text either (its SKU URL already carries the code, looked up with a plain `.find()`; see
// deriveStoneAxisValues's own comment). The frontend builds its own metalTeamCode/stoneTeamCode
// from the values here and passes those to `/:id/match-component-set` — this endpoint never
// resolves or returns a team id itself... except stoneTeamId, which is now an INPUT here, not an
// output resolved from something else.
async function getOptions(id, scope = {}, logContext = {}) {
  const { stoneTeamId, metalSelections } = scope;
  return executeOperation(
    async () => {
      const [{ count }] = await defaultSequelize.query(
        `SELECT COUNT(*)::int AS count FROM component_set WHERE component_set_details->>'baseDesignId' = :id`,
        { replacements: { id }, type: defaultSequelize.QueryTypes.SELECT }
      );
      if (count === 0) return null;

      const producedRows = await defaultSequelize.query(
        `SELECT DISTINCT
           component_set_details->>'metalTeamId' AS "metalTeamId",
           component_set_details->>'stoneTeamId' AS "stoneTeamId"
         FROM component_set
         WHERE component_set_details->>'baseDesignId' = :id`,
        { replacements: { id }, type: defaultSequelize.QueryTypes.SELECT }
      );
      const producedMetalTeamIds = new Set(producedRows.map(r => r.metalTeamId).filter(Boolean));
      const producedStoneTeamIds = new Set(producedRows.map(r => r.stoneTeamId).filter(Boolean));

      const body = await fetchJson(merchandisingUrl(`/${id}`), logContext);
      const details = body.data?.base_design_details || {};
      const producedStoneTeams = (details.stoneConfig?.stoneTeams || []).filter(t => producedStoneTeamIds.has(t.teamId));
      // Stone Type/Shape are exempted from production-filtering (user decision 2026-09-16, same
      // reasoning as Ring Size) — sourced from the FULL catalog, not just what's been produced. The
      // "has this actually been produced" check only happens later, at match-component-set time.
      const allStoneTeams = details.stoneConfig?.stoneTeams || [];

      let caratOptions = [];
      let sizeOptions = [];
      let stoneFeatureGroups = [];
      let resolvedStoneTeam = null;
      let isDefaultStoneSelection = false;

      if (stoneTeamId !== undefined) {
        resolvedStoneTeam = allStoneTeams.find(t => t.teamId === stoneTeamId);
        if (!resolvedStoneTeam) return null; // -> controller reports 404 (no such stoneTeamId on this base design)
      } else if (allStoneTeams.length > 0) {
        // No Stone Type/Shape picked yet — show SF/CT for a DEFAULT stone team anyway (rather than
        // nothing at all), matching the wireframe's own "show everything upfront" pattern. Prefer a
        // PRODUCED team (more likely genuinely matchable at the end); fall back to the full catalog
        // only if nothing's been produced yet. Always flagged via `isDefaultStoneSelection` so the
        // caller knows to re-fetch with the real stoneType+shape once the user actually picks one.
        isDefaultStoneSelection = true;
        const pool = producedStoneTeams.length > 0 ? producedStoneTeams : allStoneTeams;
        resolvedStoneTeam = [...pool].sort((a, b) => a.teamId.localeCompare(b.teamId))[0];
      }

      // MT values (Band Width etc.) are filtered to what's produced WITH the resolved stone team
      // SPECIFICALLY — not just "produced with some stone team or other" — otherwise a metal value
      // can look pickable but turn out to have never been paired with the chosen Stone Type/Shape at
      // all, a dead end only discovered at the final match-component-set call. Real example found by
      // testing: stoneTeamCode "0602" (Natural Yellow Diamond/Emerald) has ZERO component_set rows
      // at all — confirmed a genuine data gap, not a resolution bug — so no metalTeamCode should ever
      // resolve as compatible with it. Falls back to "produced with any stone team" only when no
      // stone team is resolved at all (e.g. a plain-band design with no stone teams to scope by).
      let metalScopedTeamIds = producedMetalTeamIds;
      if (resolvedStoneTeam) {
        const scopedRows = await defaultSequelize.query(
          `SELECT DISTINCT component_set_details->>'metalTeamId' AS "metalTeamId"
           FROM component_set
           WHERE component_set_details->>'baseDesignId' = :id AND component_set_details->>'stoneTeamId' = :stoneTeamId`,
          { replacements: { id, stoneTeamId: resolvedStoneTeam.teamId }, type: defaultSequelize.QueryTypes.SELECT }
        );
        metalScopedTeamIds = new Set(scopedRows.map(r => r.metalTeamId).filter(Boolean));
      }
      const producedMetalTeams = (details.metalConfig?.metalTeams || []).filter(t => metalScopedTeamIds.has(t.teamId));

      if (resolvedStoneTeam) {
        const caratGroups = details.caratConfig?.caratTeamMapping || [];
        const matchedGroup = caratGroups.find(g => (g.stoneTeams || []).includes(resolvedStoneTeam.teamId));
        caratOptions = matchedGroup?.caratOptions || [];
        sizeOptions = matchedGroup?.sizeOptions || [];

        const templateIds = (resolvedStoneTeam.teamDetails || []).map(d => d.templateId);
        stoneFeatureGroups = await fetchStoneFeaturesByTemplateId(templateIds, logContext);
      }

      const options = buildOptionsList({
        metalFeatures: details.metalConfig?.metalFeatures,
        producedMetalTeams,
        allStoneTeams,
        stoneFeatureGroups,
        caratOptions,
        sizeOptions,
      });

      const response = { baseDesignId: id, variantCount: count, options };

      if (resolvedStoneTeam) {
        response.stoneTeamId = resolvedStoneTeam.teamId;
        response.stoneTeamCode = resolvedStoneTeam.teamCode;
        if (isDefaultStoneSelection) response.isDefaultStoneSelection = true;
      }

      // Optional: once the caller has picked a value for every MT feature, resolve which real,
      // PRODUCED metal team that combination matches — same "find the one exact team" approach as
      // the stone side above, never a concatenated code. `metalSelections` is a plain
      // {featureName: valueCode} map (e.g. {"Band Width":"01","Ring Size":"06"}) — valueCode, not
      // valueText, since 2026-09-21: the caller already has each pill's own valueCode from the
      // /options response it rendered the pill from, so it can send that straight back (shorter,
      // and just as reliable — verified consistent per (featureName, valueCode) across every real
      // base_design checked) instead of the display label. Ring Size gets special handling (see
      // resolveMetalTeamForRingSize) since it's exempt from production filtering — a selected Ring
      // Size the design shows but never produced on its OWN is still resolved correctly via the
      // covering team's `supportedMetalTeamCodes`.
      if (metalSelections && Object.keys(metalSelections).length > 0) {
        const resolvedMetalTeam = resolveMetalTeamForRingSize(producedMetalTeams, details.metalConfig?.metalFeatures || [], metalSelections);
        if (resolvedMetalTeam) {
          response.metalTeamId = resolvedMetalTeam.teamId;
          response.metalTeamCode = resolvedMetalTeam.teamCode;
        }
      }

      return response;
    },
    {
      processName: logContext.processName || 'GetOptions_base_design',
      correlationId: logContext.correlationId,
      metadata: { id, stoneTeamId },
    }
  );
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The CAPTAIN/CENTER stone's own weight — never the row's summed `totalStoneWeight`, which is
// wrong for multi-stone designs (center + side stones summed together). Mirrors D:\work\cad's own
// pdp entity's identical helper — same component_set JSONB shape (`components[].stoneGroups[]`
// with `isCaptain`, `stoneDetails[].weightPerStone`), confirmed against our own real data.
function findCaptainStoneWeight(components = []) {
  for (const component of components) {
    for (const group of component.stoneGroups || []) {
      if (group.isCaptain) {
        const detail = (group.stoneDetails || [])[0];
        const weight = detail?.weightPerStone ?? detail?.totalStoneWeight;
        return weight != null ? parseFloat(weight) : null;
      }
    }
  }
  return null;
}

// Molds a raw component_set row into a compact, wireframe-aligned shape (mirrors the real
// wireframe's own "Matched Variant" panel fields — Variant Number, Ornament, Variant type, per-axis
// values, Total stones, Total stone weight — see GAPS.md, and a real wireframe screenshot the user
// compared this against directly) instead of the full raw component_set_details JSONB (which also
// carries CAD file paths, per-component manufacturing/marketing dimensions, image lists, etc. —
// internal detail this endpoint's caller doesn't need).
//
// `dimensionalSelection`/`shape`/`stoneType` are RE-RESOLVED here from base_design's own
// metalTeams[]/stoneTeams[] catalog (matched by the row's own metalTeamId/stoneTeamId) — even
// though the caller already supplied the codes that led here, the wireframe echoes the underlying
// axis VALUES (Ring Size, Band Depth, Shape) back on the matched-variant panel, so this does the
// same rather than making the caller re-derive them. `carat` is the caller's own input `caratValue`
// echoed back, since it was never a raw component_set field to begin with (matched via the CAPTAIN
// stone's own weight, not stored as a top-level column).
async function moldMatchedComponentSet(row, { baseDesignDetails, caratValue } = {}) {
  const d = row.componentSetDetails || {};

  const metalTeam = (baseDesignDetails?.metalConfig?.metalTeams || []).find(t => t.teamId === d.metalTeamId);
  const dimensionalSelection = {};
  for (const detail of metalTeam?.teamDetails || []) {
    if (detail.featureName) dimensionalSelection[detail.featureName] = detail.valueText;
  }

  const stoneTeam = (baseDesignDetails?.stoneConfig?.stoneTeams || []).find(t => t.teamId === d.stoneTeamId);
  const captainDetail = (stoneTeam?.teamDetails || [])[0];

  return {
    componentSetId: row.componentSetId,
    // Real, human-recognizable SKU/variant number (e.g. "RN0045167") — CONFUSINGLY, CAD's own
    // component_set_details JSONB ALSO has a field literally named "componentSetId" holding this,
    // distinct from the outer/technical `component_set_id` column used everywhere else in this
    // integration (image_request/variant_task/cad-file-uploaded/pending-cad-files, and CAD's own
    // /:id routes). Added 2026-09-17 — the real wireframe's "Variant Number" label needs THIS
    // value, not the technical id; without it, CAD's team (and anyone else) has no way to
    // recognize which physical piece a request is even about. See GAPS.md/RULES.md.
    variantNumber: d.componentSetId,
    ornamentName: d.ornamentName,
    variantType: d.componentSetPrefix,
    category: d.category,
    subCategory: d.subCategory,
    metalTeamId: d.metalTeamId,
    metalTeamCode: d.metalTeamCode,
    stoneTeamId: d.stoneTeamId,
    stoneTeamCode: d.stoneTeamCode,
    dimensionalSelection,
    shape: captainDetail?.shape,
    stoneType: captainDetail?.stoneType,
    carat: caratValue ?? null,
    totalNumberOfStones: d.totalNumberOfStones,
    totalStoneWeight: d.totalStoneWeight,
    dimensions: d.dimensions,
    collectionNumber: d.collectionNumber,
    collectionPrefix: d.collectionPrefix,
  };
}

// GET /:id/match-component-set?metalTeamCode=...&stoneTeamCode=...&caratValue=... — resolves a
// caller-supplied (metalTeamCode, stoneTeamCode) pair — already read straight off base_design's own
// `metalTeams[]`/`stoneTeams[]` catalog (see getOptions above), NOT reconstructed by concatenating
// value codes — down to ONE concrete `component_set` row: the actual variant/geometry to attach to
// an image_request. Mirrors D:\work\cad's own pdp entity's `findComponentSetByExactSelection` (see
// GAPS.md for the full investigation): SQL-filters by the narrow, indexable flat fields, then in JS
// matches the CAPTAIN stone's own weight against the selected carat value. Filters by baseDesignId
// directly (not collectionNumber like PDP) — our own component_set data has a reliable baseDesignId
// on every row, so there's no need for PDP's extra Merchandising round-trip just to look up
// collectionNumber first.
async function matchComponentSet(id, { metalTeamCode, stoneTeamCode, caratValue } = {}, logContext = {}) {
  if (!metalTeamCode) throw badRequest('metalTeamCode is required');
  if (stoneTeamCode === undefined) {
    throw badRequest("stoneTeamCode is required (pass an empty string for a plain-band pair with no stone team)");
  }

  let targetCarat = null;
  if (stoneTeamCode) {
    if (caratValue === undefined || caratValue === null || caratValue === '') {
      throw badRequest('caratValue is required when stoneTeamCode is non-empty');
    }
    targetCarat = parseFloat(caratValue);
    if (Number.isNaN(targetCarat)) throw badRequest(`caratValue '${caratValue}' is not a number`);
  }

  return executeOperation(
    async () => {
      const rows = await defaultSequelize.query(
        `SELECT component_set_id AS "componentSetId", component_set_details AS "componentSetDetails"
         FROM component_set
         WHERE component_set_details->>'baseDesignId' = :id
           AND component_set_details->>'metalTeamCode' = :metalTeamCode
           AND component_set_details->>'stoneTeamCode' = :stoneTeamCode`,
        { replacements: { id, metalTeamCode, stoneTeamCode }, type: defaultSequelize.QueryTypes.SELECT }
      );

      if (rows.length === 0) return null;

      // Plain-band pair — no stones, so no carat to match against. The
      // (baseDesignId, metalTeamCode, stoneTeamCode="") key is expected to already be unique.
      const matched = !stoneTeamCode
        ? (rows.length === 1 ? rows[0] : null)
        : rows.find(r => findCaptainStoneWeight(r.componentSetDetails?.components) === targetCarat) || null;
      if (!matched) return null;

      // Single-row Merchandising fetch to re-resolve the matched row's own axis VALUES (Ring Size,
      // Band Width, Shape) for the molded response — see moldMatchedComponentSet.
      const body = await fetchJson(merchandisingUrl(`/${id}`), logContext);
      return moldMatchedComponentSet(matched, { baseDesignDetails: body.data?.base_design_details, caratValue });
    },
    {
      processName: logContext.processName || 'MatchComponentSet_base_design',
      correlationId: logContext.correlationId,
      metadata: { id, metalTeamCode, stoneTeamCode, caratValue },
    }
  );
}

module.exports = { getAll, getById, getOptions, matchComponentSet };
