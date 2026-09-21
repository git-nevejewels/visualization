// src/entities/base_design/v1/routes/entityRoutes.js
// Read-only, molded response — see services/entityService.js.

const express = require('express');
const router = express.Router({ mergeParams: true });

const entityController = require('../controllers/entityController');

router.use((req, res, next) => {
  req.entityContext = { entityName: 'base_design', version: 'v1', sequelize: req.app.get('sequelize') };
  next();
});

/**
 * @swagger
 * tags:
 *   name: BaseDesign
 *   description: |
 *     Read-only, molded from Merchandising's own base_design API (which owns the entity) plus
 *     component_set/image_request-derived enrichment. Merchandising's API is the source of truth
 *     for base_design CRUD — this is a Visualization-shaped read view on top of it.
 */

/**
 * @swagger
 * /api/base_design/v1/{id}/options:
 *   get:
 *     summary: Flat, selectable feature catalog for a base design's "raise request" screen
 *     description: |
 *       ONE flat `options[]` array — mirrors D:\work\cad's own pdp entity's options shape (tagged
 *       `partOf`), minus `renderAs`/`isSelected` (this screen has no default selection to mark, and
 *       rendering is a frontend concern). `partOf` groups:
 *         - MT: metal-side features (team-forming OR non-dimensional-but-affectsImage — e.g. Ring
 *           Size, Band Width, Band Finish). The full theoretical catalog, from base_design's own
 *           metalConfig.metalFeatures.
 *         - ST: Stone Type + Shape — independent picks (NOT team-scoped), unioned across every
 *           stoneTeam this design has.
 *         - SF: stone_template quality features (Clarity/Colour/Cut Grade/etc., Certificate always
 *           excluded).
 *         - CT: Carat/Size.
 *
 *       MT and ST group VALUES are filtered to what's actually been PRODUCED — cross-referenced
 *       against component_set's own DISTINCT metalTeamId/stoneTeamId for this base_design (manager-
 *       confirmed 2026-09-16) — EXCEPT Ring Size (always the full range — explicit business
 *       decision, with a supportedMetalTeamCodes fallback at resolution time since resizing doesn't
 *       need its own geometry) and non-team affectsImage features like Band Finish (never encoded
 *       into a team code, so component_set has no opinion on them).
 *
 *       SF/CT show a DEFAULT stone-team preview (the first PRODUCED team, deterministic) even
 *       BEFORE `stoneTeamId` is given — flagged `isDefaultStoneSelection: true` — rather than
 *       nothing at all, since a base_design can reference a dozen+ distinct stone_templates and
 *       dumping all of them isn't the answer either. Pass `stoneTeamId` (read directly off the
 *       `stone_type` group's own nested `shapes[].stoneTeamId` in THIS SAME unscoped response — no
 *       separate resolution call needed, since (stoneType, shape) is already 1:1 with a stoneTeamId)
 *       to resolve the EXACT produced stone team instead, getting back its real
 *       `stoneTeamId`/`stoneTeamCode` with no `isDefaultStoneSelection` flag. Changed 2026-09-21
 *       from separate `stoneType`+`shape` TEXT params — mirrors D:\work\cad's own pdp v2 entity,
 *       which never resolves a stone team from text either (its SKU URL already carries the code).
 *
 *       Once a value is picked for every MT feature, pass them as `metalSelections` (a JSON object,
 *       {featureName: valueCode} — valueCode, not valueText, since 2026-09-21, same reasoning as
 *       stoneTeamId above: the caller already has each pill's own code from this response) to
 *       resolve the matching PRODUCED metal team the same way, getting back its real
 *       `metalTeamId`/`metalTeamCode`. Neither team code is ever reconstructed by concatenating
 *       value codes — both are read directly off the one exact team that matches.
 *       Pass BOTH resolved codes to GET /{id}/match-component-set to get the final componentSetId.
 *     tags: [BaseDesign]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *       - in: query
 *         name: stoneTeamId
 *         schema: { type: string }
 *         description: One stone team's teamId (e.g. "ST0000") — read off this same endpoint's own unscoped `stone_type` group's `shapes[].stoneTeamId`, never resolved from stoneType/shape text.
 *       - in: query
 *         name: metalSelections
 *         schema: { type: string }
 *         description: 'JSON object of {featureName: valueCode} for every MT feature, e.g. {"Band Width":"01","Ring Size":"06"}.'
 *     responses:
 *       200:
 *         description: >
 *           { baseDesignId, variantCount,
 *             options: [{ featureId, name, partOf: "MT"|"ST"|"SF"|"CT",
 *                          values: [{ valueCode?, valueText, shapes?: [{valueText, stoneTeamId, stoneTeamCode}] }] }],
 *             stoneTeamId?, stoneTeamCode?, isDefaultStoneSelection?, metalTeamId?, metalTeamCode? }
 *       400:
 *         description: metalSelections isn't valid JSON
 *       404:
 *         description: base_design not found, has no component_set variants yet, or (when scoped) no PRODUCED stone team matches the given stoneTeamId
 */
router.get('/:id/options', entityController.getOptions);

/**
 * @swagger
 * /api/base_design/v1/{id}/match-component-set:
 *   get:
 *     summary: Resolve a (metalTeamCode, stoneTeamCode[, caratValue]) selection down to one concrete component_set
 *     description: |
 *       Takes a metalTeamCode/stoneTeamCode the FRONTEND has built from the `valueCode`s in
 *       `/{id}/options`'s response and resolves the ONE component_set row matching them — the
 *       actual variant/geometry to attach to an image_request. Mirrors D:\work\cad's own pdp
 *       entity's `findComponentSetByExactSelection` (see GAPS.md): SQL-filters by baseDesignId +
 *       metalTeamCode + stoneTeamCode, then matches the CAPTAIN/CENTER stone's own weight against
 *       caratValue (never the row's summed totalStoneWeight).
 *
 *       caratValue is required whenever stoneTeamCode is non-empty (a stoned pair). Pass an empty
 *       stoneTeamCode with no caratValue for a plain-band pair. NOTE (see GAPS.md): a real data gap
 *       was found where multiple component_set rows can share the exact same (baseDesignId,
 *       metalTeamCode, stoneTeamCode="") key with no other distinguishing field — this endpoint
 *       returns 404 (not a guess) when that happens, rather than silently picking one.
 *     tags: [BaseDesign]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *       - in: query
 *         name: metalTeamCode
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: stoneTeamCode
 *         required: true
 *         schema: { type: string }
 *         description: Empty string is valid (a plain-band pair has no stone team).
 *       - in: query
 *         name: caratValue
 *         schema: { type: number }
 *         description: Required when stoneTeamCode is non-empty.
 *     responses:
 *       200:
 *         description: "{ componentSetId, componentSetDetails }"
 *       400:
 *         description: Missing metalTeamCode/stoneTeamCode, missing caratValue for a stoned pair, or a non-numeric caratValue
 *       404:
 *         description: No component_set matches the given selection
 */
router.get('/:id/match-component-set', entityController.matchComponentSet);

/**
 * @swagger
 * /api/base_design/v1/{id}:
 *   get:
 *     summary: Get a single base design, molded with axisNames/stoneTypes/metalColourBreakdown/existingRequests
 *     tags: [BaseDesign]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200:
 *         description: base_design found
 *       404:
 *         description: base_design not found
 */
router.get('/:id', entityController.getById);

/**
 * @swagger
 * /api/base_design/v1:
 *   get:
 *     summary: List/search base designs, molded with variant/team counts and enrichment
 *     tags: [BaseDesign]
 *     parameters:
 *       - in: query
 *         name: pageNumber
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: batchSize
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Matches ornamentName, referenceDesignName, collectionNumber, or the id itself
 *     responses:
 *       200:
 *         description: List of molded base designs
 */
router.get('/', entityController.getAll);

module.exports = router;
