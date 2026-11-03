var User = require('../models/user');
var utils = require('./utils');

module.exports = function (router) {
    router.route('/users')
        .get(utils.asyncHandler(listUsers))
        .post(utils.asyncHandler(createUser));

    router.route('/users/:id')
        .get(utils.asyncHandler(getUser))
        .put(utils.asyncHandler(replaceUser))
        .delete(utils.asyncHandler(deleteUser));

    return router;
};

async function listUsers(req, res) {
    var data = await utils.executeList(User, req.query, null);
    utils.send(res, 200, 'OK', data);
}

async function createUser(req, res) {
    var fields = await utils.resolveUserFields(req.body, null);
    var user = new User({
        name: fields.name,
        email: fields.email,
        pendingTasks: fields.pendingTasks,
        dateCreated: new Date()
    });
    try {
        await user.save();
    } catch (err) {
        if (err && err.code === 11000) {
            throw new utils.HttpError(400, 'A user with this email already exists');
        }
        throw err;
    }

    await utils.syncUserPendingTasks({
        userId: String(user._id),
        name: fields.name,
        oldPending: [],
        newPending: fields.pendingTasks
    });

    var stored = await User.findById(user._id);
    utils.send(res, 201, 'OK', stored);
}

async function getUser(req, res) {
    if (!utils.isValidObjectId(req.params.id)) {
        throw new utils.HttpError(404, 'User not found');
    }
    var userId = utils.canonicalId(req.params.id);
    var user = await utils.findById(User, userId);
    if (!user) {
        throw new utils.HttpError(404, 'User not found');
    }
    var select = utils.parseSelectParam(req.query.select);
    if (select) {
        user = await utils.findById(User, userId, select);
    }
    utils.send(res, 200, 'OK', user);
}

async function replaceUser(req, res) {
    if (!utils.isValidObjectId(req.params.id)) {
        throw new utils.HttpError(404, 'User not found');
    }
    var userId = utils.canonicalId(req.params.id);
    var user = await utils.findById(User, userId);
    if (!user) {
        throw new utils.HttpError(404, 'User not found');
    }

    var fields = await utils.resolveUserFields(req.body, userId);
    await utils.syncUserPendingTasks({
        userId: userId,
        name: fields.name,
        oldPending: user.pendingTasks || [],
        newPending: fields.pendingTasks
    });

    user.name = fields.name;
    user.email = fields.email;
    user.pendingTasks = fields.pendingTasks;
    try {
        await user.save();
    } catch (err) {
        if (err && err.code === 11000) {
            throw new utils.HttpError(400, 'A user with this email already exists');
        }
        throw err;
    }

    utils.send(res, 200, 'OK', user);
}

async function deleteUser(req, res) {
    if (!utils.isValidObjectId(req.params.id)) {
        throw new utils.HttpError(404, 'User not found');
    }
    var userId = utils.canonicalId(req.params.id);
    var user = await utils.findById(User, userId);
    if (!user) {
        throw new utils.HttpError(404, 'User not found');
    }

    await utils.unassignTasksForUser(userId);
    await User.deleteOne({ _id: user._id });
    res.status(204).end();
}
