var Task = require('../models/task');
var utils = require('./utils');

module.exports = function (router) {
    router.route('/tasks')
        .get(utils.asyncHandler(listTasks))
        .post(utils.asyncHandler(createTask));

    router.route('/tasks/:id')
        .get(utils.asyncHandler(getTask))
        .put(utils.asyncHandler(replaceTask))
        .delete(utils.asyncHandler(deleteTask));

    return router;
};

// Tasks default to 100 results. Users stay unlimited unless limit is sent.
async function listTasks(req, res) {
    var data = await utils.executeList(Task, req.query, 100);
    utils.send(res, 200, 'OK', data);
}

async function createTask(req, res) {
    var fields = await utils.resolveTaskFields(req.body);
    var task = new Task({
        name: fields.name,
        description: fields.description,
        deadline: fields.deadline,
        completed: fields.completed,
        assignedUser: fields.assignedUser,
        assignedUserName: fields.assignedUserName,
        dateCreated: new Date()
    });
    await task.save();

    await utils.syncTaskAssignment({
        taskId: String(task._id),
        oldAssignedUser: '',
        newAssignedUser: fields.assignedUser,
        completed: fields.completed
    });

    utils.send(res, 201, 'OK', task);
}

async function getTask(req, res) {
    if (!utils.isValidObjectId(req.params.id)) {
        throw new utils.HttpError(404, 'Task not found');
    }
    var taskId = utils.canonicalId(req.params.id);
    var task = await utils.findById(Task, taskId);
    if (!task) {
        throw new utils.HttpError(404, 'Task not found');
    }
    var select = utils.parseSelectParam(req.query.select);
    if (select) {
        task = await utils.findById(Task, taskId, select);
    }
    utils.send(res, 200, 'OK', task);
}

async function replaceTask(req, res) {
    if (!utils.isValidObjectId(req.params.id)) {
        throw new utils.HttpError(404, 'Task not found');
    }
    var taskId = utils.canonicalId(req.params.id);
    var task = await utils.findById(Task, taskId);
    if (!task) {
        throw new utils.HttpError(404, 'Task not found');
    }

    var fields = await utils.resolveTaskFields(req.body);
    var oldAssignedUser = task.assignedUser || '';

    task.name = fields.name;
    task.description = fields.description;
    task.deadline = fields.deadline;
    task.completed = fields.completed;
    task.assignedUser = fields.assignedUser;
    task.assignedUserName = fields.assignedUserName;
    await task.save();

    await utils.syncTaskAssignment({
        taskId: taskId,
        oldAssignedUser: oldAssignedUser,
        newAssignedUser: fields.assignedUser,
        completed: fields.completed
    });

    utils.send(res, 200, 'OK', task);
}

async function deleteTask(req, res) {
    if (!utils.isValidObjectId(req.params.id)) {
        throw new utils.HttpError(404, 'Task not found');
    }
    var taskId = utils.canonicalId(req.params.id);
    var task = await utils.findById(Task, taskId);
    if (!task) {
        throw new utils.HttpError(404, 'Task not found');
    }

    await utils.removeTaskFromUsers(taskId);
    await Task.deleteOne({ _id: task._id });
    res.status(204).end();
}
