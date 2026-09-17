// src/entities/image_request/v1/routes/entityRoutes.js
const express = require('express');
const path = require('path');

const router = express.Router({ mergeParams: true });

const entityController = require('../controllers/entityController');
const validateEntity = require('../middlewares/validateSchema');

// --------------------
// Auto-detect entityName and version from folder structure
// --------------------
const version = path.basename(path.dirname(__dirname)); // parent folder = version (v1)
const entityName = path.basename(path.join(__dirname, '..', '..')); // two levels up = entityName

// --------------------
// Attach entity context to request
// --------------------
router.use((req, res, next) => {
  req.entityContext = {
    entityName,
    version,
    sequelize: req.app.get('sequelize'), // global Sequelize instance
  };
  next();
});

// --------------------
// Swagger documentation
// --------------------

/**
 * @swagger
 * tags:
 *   name: ImageRequest
 *   description: CRUD APIs for Image Request
 */

/**
 * @swagger
 * /api/image_request/v1/create:
 *   post:
 *     summary: Create a new Image Request, optionally with its whole initial basket of matched variants
 *     description: |
 *       `requestedVariants` is OPTIONAL — pass a whole basket of already-matched variants (each
 *       shaped exactly like `POST /:id/variants`'s own body: componentSetId, metalTeamId/Code,
 *       stoneTeamId/Code, dimensionalSelection, metalColourGroups, stoneColours) to raise a request
 *       with its first variants in ONE call, mirroring the real wireframe's own `submitReq()` (which
 *       submits an entire basket at once, not one create + N separate variant-add calls). Every
 *       entry gets the SAME validation `POST /:id/variants` applies to a single append, plus a
 *       dedup check against every OTHER entry in the array. Omit it (or pass `[]`) to create an
 *       empty request and add variants afterward via `POST /:id/variants` as before — both are
 *       still fully supported.
 *     tags: [ImageRequest]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               baseDesignId: { type: string }
 *               requestedBy: { type: string }
 *               neededBy: { type: string, format: date-time }
 *               priority: { type: string, enum: [Standard, Rush] }
 *               requestedVariants:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     componentSetId: { type: string }
 *                     metalTeamId: { type: string }
 *                     metalTeamCode: { type: string }
 *                     stoneTeamId: { type: string }
 *                     stoneTeamCode: { type: string }
 *                     dimensionalSelection: { type: object }
 *                     metalColourGroups:
 *                       type: array
 *                       items: { type: string, enum: [white, yellow, rose] }
 *                     stoneColours:
 *                       type: array
 *                       items: { type: string }
 *             required: [baseDesignId, requestedBy]
 *     responses:
 *       201:
 *         description: Image Request created successfully
 *       400:
 *         description: A requestedVariants entry is missing a required field, or two entries are exact duplicates (same componentSetId + same colours)
 */
router.post('/create', validateEntity, entityController.create);

/**
 * @swagger
 * /api/image_request/v1/bulkCreate:
 *   post:
 *     summary: Bulk create Image Requests
 *     tags: [ImageRequest]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *     responses:
 *       201:
 *         description: Image Requests created successfully
 */
router.post('/bulkCreate', validateEntity, entityController.bulkCreate);

/**
 * @swagger
 * /api/image_request/v1/dashboard:
 *   get:
 *     summary: Overview KPIs across every Image Request
 *     description: |
 *       Registered BEFORE GET /{id} deliberately — Express matches routes in registration order,
 *       and /{id} (a param route) would otherwise capture the literal path "dashboard" as an id.
 *     tags: [ImageRequest]
 *     responses:
 *       200:
 *         description: openRequests, variantsInFlight, variantsDelivered, imageSetsOrdered, rushRequests, unassignedTasks
 */
router.get('/dashboard', entityController.getDashboard);

/**
 * @swagger
 * /api/image_request/v1/getByStats:
 *   get:
 *     summary: Get Image Requests filtered by rollup status
 *     description: |
 *       Registered BEFORE GET /{id} for the same routing-order reason as /dashboard above.
 *       'open'/'delivered' are computed by checking every requestedVariant's variant_task rows
 *       (not a stored field) — a variant with no variant_task yet counts as not-delivered.
 *
 *       Rows are molded for the "Manage visualization requests" dashboard table (2026-09-15) —
 *       NOT the raw entity row. `ornamentName`/`collectionNumber`/`collectionPrefix` come from
 *       Merchandising's base_design API (image_request itself only stores a bare `baseDesignId`
 *       reference). `stageProgress[stage].done` counts variants that have COMPLETED that stage
 *       (moved past it) — e.g. `zb.done` counts variants now at obj, rn, or Delivered.
 *       `whereItIsNow` counts variants by where they CURRENTLY sit (their current stage, Delivered,
 *       or `awaitingCad` if no variant_task exists yet).
 *     tags: [ImageRequest]
 *     parameters:
 *       - in: query
 *         name: statsStatus
 *         required: true
 *         schema:
 *           type: string
 *           enum: [open, delivered, rush]
 *       - in: query
 *         name: pageNumber
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: batchSize
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: >
 *           Filtered, molded list: [{ imageRequestId, baseDesignId, ornamentName, collectionNumber,
 *             collectionPrefix, requestedBy, neededBy, priority, status,
 *             scope: { variantCount, imageSetCount },
 *             stageProgress: { zb: {done,total}, obj: {done,total}, rn: {done,total} },
 *             whereItIsNow: { zb, obj, rn, delivered, awaitingCad },
 *             variantsDoneCount }]
 *       400:
 *         description: Invalid or missing statsStatus
 */
router.get('/getByStats', entityController.getByStats);

/**
 * @swagger
 * /api/image_request/v1/{id}:
 *   get:
 *     summary: Get a single Image Request by ID
 *     tags: [ImageRequest]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Image Request
 *     responses:
 *       200:
 *         description: Image Request found
 *       404:
 *         description: Image Request not found
 */
router.get('/:id', entityController.getById);

/**
 * @swagger
 * /api/image_request/v1:
 *   get:
 *     summary: Get all Image Requests
 *     tags: [ImageRequest]
 *     parameters:
 *       - in: query
 *         name: pageNumber
 *         schema:
 *           type: integer
 *       - in: query
 *         name: batchSize
 *         schema:
 *           type: integer
 *       - in: query
 *         name: fields
 *         schema:
 *           type: string
 *       - in: query
 *         name: filterQuery
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of Image Requests
 */
router.get('/', entityController.getAll);

/**
 * @swagger
 * /api/image_request/v1/update/{id}:
 *   put:
 *     summary: Update an Image Request
 *     tags: [ImageRequest]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Image Request to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Image Request updated successfully
 */
router.put('/update/:id', entityController.update);

/**
 * @swagger
 * /api/image_request/v1/{id}:
 *   delete:
 *     summary: Delete an Image Request
 *     tags: [ImageRequest]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Image Request to delete
 *     responses:
 *       200:
 *         description: Image Request deleted successfully
 */
router.delete('/:id', entityController.deleteEntity);

/**
 * @swagger
 * /api/image_request/v1/{id}/variants:
 *   post:
 *     summary: Add a selected variant to an Image Request
 *     description: |
 *       Appends to image_request_details.requestedVariants — the variants selected against this
 *       request's base design, recorded BEFORE any variant_task exists for them (a variant_task
 *       only gets created once FG CAD upload is confirmed, via a bff-for-app -> Visualization
 *       call). Rejects an exact duplicate (same componentSetId + same colours) already in the
 *       request. Uses a dedicated append rather than PUT /update/{id}, since the generic update's
 *       array-merge would corrupt this list.
 *     tags: [ImageRequest]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Image Request
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               componentSetId: { type: string }
 *               metalTeamId: { type: string }
 *               metalTeamCode: { type: string }
 *               stoneTeamId: { type: string }
 *               stoneTeamCode: { type: string }
 *               dimensionalSelection: { type: object }
 *               metalColourGroups:
 *                 type: array
 *                 items: { type: string, enum: [white, yellow, rose] }
 *               stoneColours:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Variant added successfully
 *       400:
 *         description: Missing required field, or an exact duplicate already in the request
 *       404:
 *         description: Image Request not found
 */
router.post('/:id/variants', entityController.addRequestedVariant);

/**
 * @swagger
 * /api/image_request/v1/{id}/variants:
 *   get:
 *     summary: Request detail rollup — every requestedVariant plus its current stage/status
 *     description: |
 *       Computed from variant_task rows, never stored. A variant with no variant_task row yet
 *       shows currentStatus "Awaiting CAD".
 *     tags: [ImageRequest]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: "{ imageRequest, variants: [{ componentSetId, ..., stages: {zb,obj,rn}, currentStage, currentStatus, imageSets }] }"
 *       404:
 *         description: Image Request not found
 */
router.get('/:id/variants', entityController.getVariantsDetail);

module.exports = router;
