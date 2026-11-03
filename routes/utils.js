var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}

function send(res, status, message, data) {
    res.status(status).json({ message: message, data: data });
}

function asyncHandler(fn) {
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(function (err) {
            if (err instanceof HttpError) {
                return send(res, err.status, err.message, null);
            }
            if (err && err.code === 11000) {
                return send(res, 400, 'A user with this email already exists', null);
            }
            if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
                return send(res, 400, 'Invalid request', null);
            }
            return next(err);
        });
    };
}

function isValidObjectId(id) {
    return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);
}

function canonicalId(id) {
    return new mongoose.Types.ObjectId(id).toHexString();
}

function objectId(id) {
    return new mongoose.Types.ObjectId(id);
}

function objectIds(ids) {
    return ids.map(function (id) {
        return new mongoose.Types.ObjectId(id);
    });
}

function assertBody(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Request body must be a JSON object');
    }
}

function hasField(body, key) {
    return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

function requireNonEmptyString(value, message) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new HttpError(400, message);
    }
    return value;
}

function parseDeadline(value) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw new HttpError(400, 'Deadline is required and must be a valid date');
        }
        return value;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new HttpError(400, 'Deadline is required and must be a valid date');
    }
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new HttpError(400, 'Deadline is required and must be a valid date');
    }
    return date;
}

function parseJsonObject(value, label) {
    if (value === undefined) {
        return undefined;
    }
    if (Array.isArray(value)) {
        throw new HttpError(400, 'Invalid ' + label + ' parameter');
    }

    var parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (err) {
            throw new HttpError(400, 'Invalid ' + label + ' parameter');
        }
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'Invalid ' + label + ' parameter');
    }
    return parsed;
}

function assertSort(sort) {
    if (!sort) {
        return;
    }
    var keys = Object.keys(sort);
    for (var i = 0; i < keys.length; i++) {
        if (sort[keys[i]] !== 1 && sort[keys[i]] !== -1) {
            throw new HttpError(400, 'Invalid sort parameter');
        }
    }
}

function assertSelect(select) {
    if (!select) {
        return;
    }
    var flags = [];
    var keys = Object.keys(select);
    for (var i = 0; i < keys.length; i++) {
        var value = select[keys[i]];
        if (value !== 0 && value !== 1) {
            throw new HttpError(400, 'Invalid select parameter');
        }
        if (keys[i] !== '_id') {
            flags.push(value);
        }
    }
    if (flags.indexOf(0) !== -1 && flags.indexOf(1) !== -1) {
        throw new HttpError(400, 'Invalid select parameter');
    }
}

function parseNonNegativeInteger(value, label) {
    if (value === undefined) {
        return undefined;
    }
    if (Array.isArray(value) || typeof value === 'boolean' || value === null) {
        throw new HttpError(400, 'Invalid ' + label + ' parameter');
    }
    var text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^(0|[1-9]\d*)$/.test(text)) {
        throw new HttpError(400, 'Invalid ' + label + ' parameter');
    }
    return Number(text);
}

function parseCollectionQuery(query) {
    var where = parseJsonObject(query.where, 'where') || {};
    var sort = parseJsonObject(query.sort, 'sort');
    var select = parseJsonObject(query.select, 'select');
    assertSort(sort);
    assertSelect(select);
    if (sort && Object.keys(sort).length === 0) {
        sort = undefined;
    }
    if (select && Object.keys(select).length === 0) {
        select = undefined;
    }
    return {
        where: where,
        sort: sort,
        select: select,
        skip: parseNonNegativeInteger(query.skip, 'skip'),
        limit: parseNonNegativeInteger(query.limit, 'limit'),
        count: query.count === 'true' || query.count === true
    };
}

function parseSelectParam(value) {
    var select = parseJsonObject(value, 'select');
    assertSelect(select);
    if (!select || Object.keys(select).length === 0) {
        return undefined;
    }
    return select;
}

function isClientQueryError(err) {
    if (!err || err instanceof HttpError) {
        return false;
    }
    if (err.name === 'CastError' || err.name === 'StrictModeError') {
        return true;
    }
    var message = String(err.message || '');
    return /projection|sort specifier|cannot do exclusion|inclusion/i.test(message);
}

async function executeList(Model, query, defaultLimit) {
    var parsed = parseCollectionQuery(query);
    try {
        if (parsed.count) {
            return await Model.countDocuments(parsed.where);
        }
        if (parsed.limit === 0) {
            return [];
        }

        var cursor = Model.find(parsed.where);
        if (parsed.sort) {
            cursor = cursor.sort(parsed.sort);
        }
        if (parsed.select) {
            cursor = cursor.select(parsed.select);
        }
        if (parsed.skip !== undefined) {
            cursor = cursor.skip(parsed.skip);
        }
        var limit = parsed.limit !== undefined ? parsed.limit : defaultLimit;
        if (limit !== undefined && limit !== null) {
            cursor = cursor.limit(limit);
        }
        return await cursor.exec();
    } catch (err) {
        if (isClientQueryError(err)) {
            throw new HttpError(400, 'Invalid query parameter');
        }
        throw err;
    }
}

async function findById(Model, id, select) {
    try {
        var query = Model.findById(id);
        if (select) {
            query = query.select(select);
        }
        return await query.exec();
    } catch (err) {
        if (err instanceof HttpError) {
            throw err;
        }
        if (isClientQueryError(err)) {
            throw new HttpError(400, 'Invalid select parameter');
        }
        throw err;
    }
}

async function resolveUserFields(body, selfId) {
    assertBody(body);
    var name = requireNonEmptyString(body.name, 'Name is required and must be a non-empty string');
    var email = requireNonEmptyString(body.email, 'Email is required and must be a non-empty string');

    var pending = [];
    if (hasField(body, 'pendingTasks')) {
        if (!Array.isArray(body.pendingTasks)) {
            throw new HttpError(400, 'pendingTasks must be an array of task ids');
        }
        pending = body.pendingTasks;
    }

    var newIds = [];
    var seen = new Set();
    for (var i = 0; i < pending.length; i++) {
        var id = pending[i];
        if (typeof id !== 'string' || !isValidObjectId(id)) {
            throw new HttpError(400, 'pendingTasks contains an invalid task id');
        }
        var canonical = canonicalId(id);
        if (!seen.has(canonical)) {
            seen.add(canonical);
            newIds.push(canonical);
        }
    }

    var emailOwner = await User.findOne({ email: email });
    if (emailOwner && String(emailOwner._id) !== String(selfId || '')) {
        throw new HttpError(400, 'A user with this email already exists');
    }

    if (newIds.length > 0) {
        var tasks = await Task.find({ _id: { $in: newIds } });
        if (tasks.length !== newIds.length) {
            throw new HttpError(404, 'One or more tasks were not found');
        }
        var hasCompleted = tasks.some(function (task) {
            return task.completed;
        });
        if (hasCompleted) {
            throw new HttpError(400, 'Completed tasks cannot be in pendingTasks');
        }
    }

    return {
        name: name,
        email: email,
        pendingTasks: newIds
    };
}

async function resolveTaskFields(body) {
    assertBody(body);
    var name = requireNonEmptyString(body.name, 'Name is required and must be a non-empty string');
    if (!hasField(body, 'deadline')) {
        throw new HttpError(400, 'Deadline is required and must be a valid date');
    }
    var deadline = parseDeadline(body.deadline);

    var description = '';
    if (hasField(body, 'description')) {
        if (typeof body.description !== 'string') {
            throw new HttpError(400, 'Description must be a string');
        }
        description = body.description;
    }

    var completed = false;
    if (hasField(body, 'completed')) {
        if (typeof body.completed !== 'boolean') {
            throw new HttpError(400, 'Completed must be a boolean');
        }
        completed = body.completed;
    }

    var assignedUser = '';
    if (hasField(body, 'assignedUser')) {
        if (typeof body.assignedUser !== 'string') {
            throw new HttpError(400, 'assignedUser must be a string');
        }
        assignedUser = body.assignedUser;
    }

    var assignedUserNameProvided = false;
    var assignedUserName;
    if (hasField(body, 'assignedUserName')) {
        if (typeof body.assignedUserName !== 'string') {
            throw new HttpError(400, 'assignedUserName must be a string');
        }
        assignedUserNameProvided = true;
        assignedUserName = body.assignedUserName;
    }

    if (assignedUser === '') {
        if (assignedUserNameProvided && assignedUserName !== 'unassigned') {
            throw new HttpError(400, 'assignedUserName does not match the assigned user');
        }
        return {
            name: name,
            description: description,
            deadline: deadline,
            completed: completed,
            assignedUser: '',
            assignedUserName: 'unassigned'
        };
    }

    if (!isValidObjectId(assignedUser)) {
        throw new HttpError(400, 'assignedUser is not a valid id');
    }
    assignedUser = canonicalId(assignedUser);

    var user = await User.findById(assignedUser);
    if (!user) {
        throw new HttpError(404, 'Assigned user not found');
    }
    if (assignedUserNameProvided && assignedUserName !== user.name) {
        throw new HttpError(400, 'assignedUserName does not match the assigned user');
    }

    return {
        name: name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: user.name
    };
}

// Keep User.pendingTasks and Task.assignedUser / assignedUserName in agreement.
// oldPending is the user's previous list; newPending is the replacement list.
async function syncUserPendingTasks(options) {
    var userId = options.userId;
    var name = options.name;
    var oldIds = [];
    var seenOld = new Set();
    (options.oldPending || []).forEach(function (id) {
        var value = String(id);
        if (!seenOld.has(value)) {
            seenOld.add(value);
            oldIds.push(value);
        }
    });
    var newIds = options.newPending;
    var newSet = new Set(newIds);
    var removed = oldIds.filter(function (id) {
        return !newSet.has(id);
    });

    if (newIds.length > 0) {
        await User.updateMany(
            { _id: { $ne: objectId(userId) } },
            { $pull: { pendingTasks: { $in: newIds } } }
        );
    }

    if (removed.length > 0) {
        await Task.updateMany(
            { _id: { $in: objectIds(removed) } },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );
    }

    var stillPending = {
        assignedUser: userId,
        completed: false
    };
    if (newIds.length > 0) {
        stillPending._id = { $nin: objectIds(newIds) };
    }
    await Task.updateMany(stillPending, {
        $set: { assignedUser: '', assignedUserName: 'unassigned' }
    });

    await Task.updateMany(
        { assignedUser: userId },
        { $set: { assignedUserName: name } }
    );

    if (newIds.length > 0) {
        await Task.updateMany(
            { _id: { $in: objectIds(newIds) } },
            { $set: { assignedUser: userId, assignedUserName: name } }
        );
    }
}

// Apply one task's assignment to the previous and next users' pendingTasks.
async function syncTaskAssignment(options) {
    var taskId = options.taskId;
    var oldAssignedUser = options.oldAssignedUser || '';
    var newAssignedUser = options.newAssignedUser || '';

    if (oldAssignedUser && oldAssignedUser !== newAssignedUser) {
        await User.updateOne(
            { _id: objectId(oldAssignedUser) },
            { $pull: { pendingTasks: taskId } }
        );
    }

    if (!newAssignedUser) {
        return;
    }

    if (options.completed) {
        await User.updateOne(
            { _id: objectId(newAssignedUser) },
            { $pull: { pendingTasks: taskId } }
        );
        return;
    }

    await User.updateOne(
        { _id: objectId(newAssignedUser) },
        { $addToSet: { pendingTasks: taskId } }
    );
}

async function unassignTasksForUser(userId) {
    await Task.updateMany(
        { assignedUser: userId },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
    );
}

async function removeTaskFromUsers(taskId) {
    await User.updateMany(
        { pendingTasks: taskId },
        { $pull: { pendingTasks: taskId } }
    );
}

module.exports = {
    HttpError: HttpError,
    send: send,
    asyncHandler: asyncHandler,
    isValidObjectId: isValidObjectId,
    canonicalId: canonicalId,
    executeList: executeList,
    parseSelectParam: parseSelectParam,
    findById: findById,
    resolveUserFields: resolveUserFields,
    resolveTaskFields: resolveTaskFields,
    syncUserPendingTasks: syncUserPendingTasks,
    syncTaskAssignment: syncTaskAssignment,
    unassignTasksForUser: unassignTasksForUser,
    removeTaskFromUsers: removeTaskFromUsers
};
