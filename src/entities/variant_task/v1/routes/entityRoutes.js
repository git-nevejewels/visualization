// src/entities/variant_task/v1/routes/entityRoutes.js
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
 *   name: VariantTask
 *   description: CRUD APIs for Variant Task
 */

/**
 * @swagger
 * /api/variant_task/v1/create:
 *   post:
 *     summary: Create a new Variant Task
 *     tags: [VariantTask]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       201:
 *         description: Variant Task created successfully
 */
router.post('/create', validateEntity, entityController.create);

/**
 * @swagger
 * /api/variant_task/v1/bulkCreate:
 *   post:
 *     summary: Bulk create Variant Tasks
 *     tags: [VariantTask]
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
 *         description: Variant Tasks created successfully
 */
router.post('/bulkCreate', validateEntity, entityController.bulkCreate);

/**
 * @swagger
 * /api/variant_task/v1/{id}:
 *   get:
 *     summary: Get a single Variant Task by ID
 *     tags: [VariantTask]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Variant Task
 *     responses:
 *       200:
 *         description: Variant Task found
 *       404:
 *         description: Variant Task not found
 */
router.get('/:id', entityController.getById);

/**
 * @swagger
 * /api/variant_task/v1:
 *   get:
 *     summary: Get all Variant Tasks
 *     tags: [VariantTask]
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
 *         description: List of Variant Tasks
 */
router.get('/', entityController.getAll);

/**
 * @swagger
 * /api/variant_task/v1/update/{id}:
 *   put:
 *     summary: Update a Variant Task
 *     tags: [VariantTask]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Variant Task to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Variant Task updated successfully
 */
router.put('/update/:id', entityController.update);

/**
 * @swagger
 * /api/variant_task/v1/{id}:
 *   delete:
 *     summary: Delete a Variant Task
 *     tags: [VariantTask]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Variant Task to delete
 *     responses:
 *       200:
 *         description: Variant Task deleted successfully
 */
router.delete('/:id', entityController.deleteEntity);

/**
 * @swagger
 * /api/variant_task/v1/{id}/action:
 *   post:
 *     summary: Apply a workflow action to a single Variant Task
 *     description: |
 *       Mirrors visualization_studio_v15.html's assign()/start()/advance()/hold()/complete().
 *       Each action is only legal from a specific current status — see RULES.md. Completing
 *       zb or obj auto-creates the next stage's task for the same variant.
 *     tags: [VariantTask]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the Variant Task
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [assign, start, advance, hold, complete]
 *               actionBy:
 *                 type: string
 *                 description: Required for assign, and for start when the task has no assignee yet.
 *     responses:
 *       200:
 *         description: Action applied successfully
 *       400:
 *         description: Unknown action, or illegal from the task's current status
 *       404:
 *         description: Variant Task not found
 */
router.post('/:id/action', entityController.performAction);

/**
 * @swagger
 * /api/variant_task/v1/bulk-action:
 *   post:
 *     summary: Apply the same workflow action to multiple Variant Tasks
 *     description: |
 *       Not atomic — each id succeeds or fails independently and every outcome is reported,
 *       matching the wireframe's own bulk() behavior.
 *     tags: [VariantTask]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *               action:
 *                 type: string
 *                 enum: [assign, start, advance, hold, complete]
 *               actionBy:
 *                 type: string
 *     responses:
 *       200:
 *         description: Per-id results (each with its own status)
 */
router.post('/bulk-action', entityController.bulkPerformAction);

/**
 * @swagger
 * /api/variant_task/v1/cad-file-uploaded:
 *   post:
 *     summary: Notification from CAD once componentSetCadPath is set for a componentSetId
 *     description: |
 *       Called by CAD's own service DIRECTLY (service-to-service, not through the BFF) right after
 *       their CAD user pastes the FG CAD file's existing shared-drive path into a plain textbox on
 *       CAD's side and `component_set_details.componentSetCadPath` is set to that same string.
 *       There is NO cloud upload anywhere in this flow (manager decision 2026-09-17) — CAD users
 *       already save .3dm files to an existing "FG CAD" shared drive; `cadFilePath` here is just
 *       that path string, copied through unchanged. This is a fire-and-forget NOTIFICATION only —
 *       no file bytes ever pass through Visualization, and never did.
 *
 *       CAD has no concept of Visualization's own `image_request`/`imageRequestId` (confirmed by
 *       reading D:\work\cad in full — see GAPS.md), so this takes `componentSetId` + `cadFilePath`
 *       and resolves which image_request(s) are actually waiting on it itself. Sets `cadFilePath`
 *       on every matching `requestedVariants` entry across those requests (manager decision
 *       2026-09-17: the path belongs on the variant inside the visualization request, NOT on CAD's
 *       own component_set — the visualization team needs to see the actual document while working
 *       a variant, not just a flag; see GAPS.md/RULES.md), then creates a `zb` variant_task for
 *       EVERY open request whose basket contains this componentSetId and doesn't already have one
 *       (the same componentSetId can legitimately sit in more than one open request). Zero matches
 *       is a valid no-op, not an error.
 *
 *       Idempotent — safe for CAD to retry this call if it fails; re-calling for a componentSetId
 *       that already has a `zb` task for a given request just skips creating another one (the
 *       `cadFilePath` update itself is applied every time, harmlessly, if it ever changes).
 *     tags: [VariantTask]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               componentSetId: { type: string }
 *               cadFilePath: { type: string, description: "The existing FG CAD shared-drive path the CAD user pasted in, e.g. \\\\fileserver\\FG_CAD\\...\\file.3dm — copied through verbatim, never validated as a URL" }
 *             required: [componentSetId, cadFilePath]
 *     responses:
 *       200:
 *         description: "{ componentSetId, createdFor: [imageRequestId], alreadyExistedFor: [imageRequestId] }"
 *       400:
 *         description: componentSetId or cadFilePath is missing
 */
router.post('/cad-file-uploaded', entityController.handleCadFileUploaded);

module.exports = router;
