const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const app = require('../server');
const User = require('../models/user');
const Task = require('../models/task');

const DEADLINE = '2026-12-01T00:00:00.000Z';

function assertError(res, status) {
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.equal(typeof res.body.message, 'string');
    assert.ok(res.body.message.trim().length > 0);
    assert.equal(res.body.data, null);
    assert.doesNotMatch(res.body.message, /mongoose|MongoServerError|Cast to|E11000|ValidationError/i);
}

describe('CS409 MP3 API', { concurrency: false }, () => {
    let mongoServer;
    let emailCounter = 0;

    before(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());
        await Promise.all([User.init(), Task.init()]);
    }, { timeout: 180000 });

    after(async () => {
        await mongoose.disconnect();
        if (mongoServer) {
            await mongoServer.stop();
        }
    });

    beforeEach(async () => {
        emailCounter = 0;
        await Promise.all([
            User.deleteMany({}),
            Task.deleteMany({})
        ]);
    });

    function nextEmail(prefix) {
        emailCounter += 1;
        return prefix + '-' + emailCounter + '@example.com';
    }

    async function createUser(fields) {
        var payload = Object.assign({
            name: 'Ada Lovelace',
            email: nextEmail('ada')
        }, fields || {});
        var res = await request(app).post('/api/users').send(payload);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.message, 'OK');
        return res.body.data;
    }

    async function createTask(fields) {
        var payload = Object.assign({
            name: 'Write tests',
            deadline: DEADLINE
        }, fields || {});
        var res = await request(app).post('/api/tasks').send(payload);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.message, 'OK');
        return res.body.data;
    }

    async function getUser(id) {
        var res = await request(app).get('/api/users/' + id);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.data;
    }

    async function getTask(id) {
        var res = await request(app).get('/api/tasks/' + id);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.data;
    }

    describe('users', () => {
        it('creates a user with server defaults and ignores client dateCreated', async () => {
            var res = await request(app).post('/api/users').send({
                name: 'Grace Hopper',
                email: 'grace@example.com',
                dateCreated: '1999-01-01T00:00:00.000Z'
            });
            assert.equal(res.status, 201);
            assert.equal(res.body.message, 'OK');
            assert.equal(res.body.data.name, 'Grace Hopper');
            assert.equal(res.body.data.email, 'grace@example.com');
            assert.deepEqual(res.body.data.pendingTasks, []);
            assert.equal(typeof res.body.data._id, 'string');
            assert.ok(res.body.data.dateCreated);
            assert.equal(res.body.data.dateCreated.startsWith('1999'), false);
            assert.ok(Math.abs(Date.now() - new Date(res.body.data.dateCreated).getTime()) < 60000);
        });

        it('rejects users that are missing a name or email, have the wrong type, or a bad pendingTasks list', async () => {
            var bodies = [
                {},
                { name: 'A' },
                { email: 'a@example.com' },
                { name: '', email: 'a@example.com' },
                { name: '   ', email: 'a@example.com' },
                { name: 1, email: 'a@example.com' },
                { name: 'A', email: '' },
                { name: 'A', email: 5 },
                { name: null, email: 'a@example.com' },
                { name: 'A', email: 'a@example.com', pendingTasks: 'nope' },
                { name: 'A', email: 'a@example.com', pendingTasks: [1] },
                { name: 'A', email: 'a@example.com', pendingTasks: ['not-an-id'] },
                { name: 'A', email: 'a@example.com', pendingTasks: [''] }
            ];
            for (var i = 0; i < bodies.length; i++) {
                var res = await request(app).post('/api/users').send(bodies[i]);
                assertError(res, 400);
            }
            assert.equal(await User.countDocuments(), 0);
        });

        it('rejects a duplicate email', async () => {
            await createUser({ email: 'same@example.com' });
            var res = await request(app).post('/api/users').send({
                name: 'Other',
                email: 'same@example.com'
            });
            assertError(res, 400);
            assert.equal(await User.countDocuments(), 1);
        });

        it('lists users and returns 200 with an empty list when nothing matches', async () => {
            var user = await createUser({ name: 'Ada' });
            var list = await request(app).get('/api/users');
            assert.equal(list.status, 200);
            assert.equal(list.body.message, 'OK');
            assert.equal(list.body.data.length, 1);
            assert.equal(list.body.data[0]._id, user._id);

            var missing = await request(app).get('/api/users').query({
                where: JSON.stringify({ _id: new mongoose.Types.ObjectId().toString() })
            });
            assert.equal(missing.status, 200);
            assert.deepEqual(missing.body.data, []);

            var counted = await request(app).get('/api/users').query({
                where: JSON.stringify({ name: 'missing' }),
                count: 'true'
            });
            assert.equal(counted.status, 200);
            assert.equal(counted.body.data, 0);
        });

        it('does not cap the user list unless limit is provided', async () => {
            var docs = [];
            for (var i = 0; i < 105; i++) {
                docs.push({
                    name: 'User ' + String(i).padStart(3, '0'),
                    email: 'bulk-' + i + '@example.com',
                    pendingTasks: [],
                    dateCreated: new Date()
                });
            }
            await User.insertMany(docs);
            var all = await request(app).get('/api/users');
            assert.equal(all.status, 200);
            assert.equal(all.body.data.length, 105);
            var page = await request(app).get('/api/users').query({ limit: 10, skip: 5 });
            assert.equal(page.body.data.length, 10);
        });

        it('sorts, skips, limits, and selects users together', async () => {
            await createUser({ name: 'Cara' });
            await createUser({ name: 'Ada' });
            await createUser({ name: 'Bea' });
            await createUser({ name: 'Eve' });
            await createUser({ name: 'Dia' });
            var res = await request(app).get('/api/users').query({
                sort: JSON.stringify({ name: 1 }),
                skip: 1,
                limit: 2,
                select: JSON.stringify({ name: 1, _id: 0 })
            });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, [{ name: 'Bea' }, { name: 'Cara' }]);

            var descending = await request(app).get('/api/users').query({
                sort: JSON.stringify({ name: -1 }),
                select: JSON.stringify({ name: 1, _id: 0 })
            });
            assert.deepEqual(descending.body.data.map(function (user) { return user.name; }), [
                'Eve', 'Dia', 'Cara', 'Bea', 'Ada'
            ]);
        });

        it('returns 400 for invalid user query parameters and does not leak database errors', async () => {
            var badQueries = [
                { where: '{bad' },
                { where: 'null' },
                { where: '[]' },
                { where: JSON.stringify({ _id: 'nope' }) },
                { sort: '{bad' },
                { sort: JSON.stringify({ name: 2 }) },
                { select: JSON.stringify({ name: 1, email: 0 }) },
                { skip: -1 },
                { skip: '1.5' },
                { limit: 'abc' }
            ];
            for (var i = 0; i < badQueries.length; i++) {
                var res = await request(app).get('/api/users').query(badQueries[i]);
                assertError(res, 400);
            }
        });

        it('gets one user, applies select, and ignores other query parameters', async () => {
            var user = await createUser({ name: 'Ada', email: 'ada@example.com' });
            var found = await request(app).get('/api/users/' + user._id.toUpperCase()).query({
                select: JSON.stringify({ name: 1, _id: 0 }),
                where: '{not json',
                sort: JSON.stringify({ name: -1 }),
                skip: 3,
                limit: 1
            });
            assert.equal(found.status, 200);
            assert.deepEqual(found.body.data, { name: 'Ada' });

            var excluded = await request(app).get('/api/users/' + user._id).query({
                select: JSON.stringify({ email: 0 })
            });
            assert.equal(excluded.status, 200);
            assert.equal(excluded.body.data.email, undefined);
            assert.equal(excluded.body.data.name, 'Ada');
        });

        it('returns 404 for a missing or malformed user id on GET, PUT, and DELETE', async () => {
            var missing = new mongoose.Types.ObjectId().toString();
            var paths = ['/api/users/not-an-id', '/api/users/' + missing];
            for (var i = 0; i < paths.length; i++) {
                assertError(await request(app).get(paths[i] + '?select={'), 404);
                assertError(await request(app).put(paths[i]).send({}), 404);
                assertError(await request(app).delete(paths[i]), 404);
            }
        });

        it('replaces a user, keeps dateCreated, and can keep the same email', async () => {
            var user = await createUser({ name: 'Ada', email: 'ada@example.com' });
            var res = await request(app).put('/api/users/' + user._id).send({
                name: 'Augusta',
                email: 'ada@example.com',
                dateCreated: '1999-01-01T00:00:00.000Z'
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.message, 'OK');
            assert.equal(res.body.data.name, 'Augusta');
            assert.equal(res.body.data.email, 'ada@example.com');
            assert.deepEqual(res.body.data.pendingTasks, []);
            assert.equal(res.body.data.dateCreated, user.dateCreated);

            var other = await createUser({ email: 'taken@example.com' });
            var conflict = await request(app).put('/api/users/' + user._id).send({
                name: 'Augusta',
                email: other.email
            });
            assertError(conflict, 400);
            var unchanged = await getUser(user._id);
            assert.equal(unchanged.email, 'ada@example.com');
            assert.equal(unchanged.name, 'Augusta');
        });

        it('rejects an invalid replacement without changing the user', async () => {
            var user = await createUser({ name: 'Ada', email: 'ada@example.com' });
            var res = await request(app).put('/api/users/' + user._id).send({ email: 'ada@example.com' });
            assertError(res, 400);
            var stored = await getUser(user._id);
            assert.equal(stored.name, 'Ada');
            assert.equal(stored.dateCreated, user.dateCreated);
        });

        it('deletes a user and then returns 404', async () => {
            var user = await createUser();
            var res = await request(app).delete('/api/users/' + user._id);
            assert.equal(res.status, 204);
            assert.equal(res.text, '');
            assertError(await request(app).get('/api/users/' + user._id), 404);
        });
    });

    describe('tasks', () => {
        it('creates a task with defaults and ignores client dateCreated', async () => {
            var res = await request(app).post('/api/tasks').send({
                name: 'Ship API',
                deadline: DEADLINE,
                dateCreated: '1999-01-01T00:00:00.000Z'
            });
            assert.equal(res.status, 201);
            assert.equal(res.body.data.name, 'Ship API');
            assert.equal(res.body.data.description, '');
            assert.equal(res.body.data.completed, false);
            assert.equal(res.body.data.assignedUser, '');
            assert.equal(res.body.data.assignedUserName, 'unassigned');
            assert.equal(new Date(res.body.data.deadline).toISOString(), DEADLINE);
            assert.equal(res.body.data.dateCreated.startsWith('1999'), false);
        });

        it('rejects tasks missing a name or deadline or using the wrong types', async () => {
            var bodies = [
                {},
                { name: 'T' },
                { deadline: DEADLINE },
                { name: '', deadline: DEADLINE },
                { name: '   ', deadline: DEADLINE },
                { name: 1, deadline: DEADLINE },
                { name: 'T', deadline: 'tomorrow' },
                { name: 'T', deadline: 1700000000000 },
                { name: 'T', deadline: '' },
                { name: 'T', deadline: DEADLINE, completed: 'false' },
                { name: 'T', deadline: DEADLINE, description: 4 },
                { name: 'T', deadline: DEADLINE, assignedUser: 5 },
                { name: 'T', deadline: DEADLINE, assignedUser: 'bad-id' },
                { name: 'T', deadline: DEADLINE, assignedUserName: 1 },
                { name: 'T', deadline: DEADLINE, assignedUserName: 'someone' }
            ];
            for (var i = 0; i < bodies.length; i++) {
                assertError(await request(app).post('/api/tasks').send(bodies[i]), 400);
            }
            assert.equal(await Task.countDocuments(), 0);
        });

        it('returns 404 when assignedUser is well formed but missing, before a name mismatch', async () => {
            var res = await request(app).post('/api/tasks').send({
                name: 'T',
                deadline: DEADLINE,
                assignedUser: new mongoose.Types.ObjectId().toString(),
                assignedUserName: 'Nope'
            });
            assertError(res, 404);
            assert.equal(await Task.countDocuments(), 0);
        });

        it('fills in assignedUserName and rejects a name that does not match', async () => {
            var user = await createUser({ name: 'Ada Lovelace' });
            var created = await createTask({ assignedUser: user._id });
            assert.equal(created.assignedUser, user._id);
            assert.equal(created.assignedUserName, 'Ada Lovelace');
            var owner = await getUser(user._id);
            assert.deepEqual(owner.pendingTasks, [created._id]);

            var mismatch = await request(app).post('/api/tasks').send({
                name: 'Other',
                deadline: DEADLINE,
                assignedUser: user._id,
                assignedUserName: 'Grace'
            });
            assertError(mismatch, 400);
            assert.equal(await Task.countDocuments(), 1);
            assert.deepEqual((await getUser(user._id)).pendingTasks, [created._id]);
        });

        it('filters, sorts, pages, and counts tasks', async () => {
            await createTask({ name: 'alpha', completed: false });
            await createTask({ name: 'bravo', completed: true });
            await createTask({ name: 'charlie', completed: true });
            await createTask({ name: 'delta', completed: false });

            var done = await request(app).get('/api/tasks').query({
                where: JSON.stringify({ completed: true }),
                sort: JSON.stringify({ name: 1 }),
                select: JSON.stringify({ name: 1, _id: 0 })
            });
            assert.equal(done.status, 200);
            assert.deepEqual(done.body.data, [{ name: 'bravo' }, { name: 'charlie' }]);

            var page = await request(app).get('/api/tasks').query({
                sort: JSON.stringify({ name: 1 }),
                skip: 1,
                limit: 2,
                select: JSON.stringify({ name: 1, _id: 0 })
            });
            assert.deepEqual(page.body.data, [{ name: 'bravo' }, { name: 'charlie' }]);

            var count = await request(app).get('/api/tasks').query({
                where: JSON.stringify({ completed: true }),
                count: 'true',
                limit: 1,
                skip: 1
            });
            assert.equal(count.status, 200);
            assert.equal(count.body.data, 2);

            var documents = await request(app).get('/api/tasks').query({ count: 'false' });
            assert.equal(Array.isArray(documents.body.data), true);
        });

        it('returns tasks by id set and uses a default limit of 100', async () => {
            var first = await createTask({ name: 'one' });
            var second = await createTask({ name: 'two' });
            await createTask({ name: 'three' });
            var subset = await request(app).get('/api/tasks').query({
                where: JSON.stringify({ _id: { $in: [first._id, second._id] } }),
                sort: JSON.stringify({ name: 1 })
            });
            assert.equal(subset.status, 200);
            assert.deepEqual(subset.body.data.map(function (task) { return task.name; }), ['one', 'two']);

            var docs = [];
            for (var i = 0; i < 120; i++) {
                docs.push({
                    name: 'Bulk ' + String(i).padStart(3, '0'),
                    deadline: new Date(DEADLINE),
                    description: '',
                    completed: false,
                    assignedUser: '',
                    assignedUserName: 'unassigned',
                    dateCreated: new Date()
                });
            }
            await Task.deleteMany({});
            await Task.insertMany(docs);
            var limited = await request(app).get('/api/tasks');
            assert.equal(limited.body.data.length, 100);
            var explicit = await request(app).get('/api/tasks').query({ limit: 120 });
            assert.equal(explicit.body.data.length, 120);
            var empty = await request(app).get('/api/tasks').query({ limit: 0 });
            assert.deepEqual(empty.body.data, []);
        });

        it('returns 400 for an invalid task query and 404 for an unknown task id', async () => {
            assertError(await request(app).get('/api/tasks').query({ where: '{' }), 400);
            assertError(await request(app).get('/api/tasks').query({
                select: JSON.stringify({ name: 1, deadline: 0 })
            }), 400);

            var task = await createTask({ name: 'Visible', description: 'notes' });
            var selected = await request(app).get('/api/tasks/' + task._id).query({
                select: JSON.stringify({ name: 1, _id: 0 }),
                where: JSON.stringify({ name: 'other' })
            });
            assert.deepEqual(selected.body.data, { name: 'Visible' });

            var missing = new mongoose.Types.ObjectId().toString();
            assertError(await request(app).get('/api/tasks/not-an-id'), 404);
            assertError(await request(app).get('/api/tasks/' + missing + '?select={'), 404);
            assertError(await request(app).put('/api/tasks/not-an-id').send({}), 404);
            assertError(await request(app).put('/api/tasks/' + missing).send({
                name: 'X',
                deadline: DEADLINE
            }), 404);
            assertError(await request(app).delete('/api/tasks/' + missing), 404);
        });

        it('replaces the whole task, preserves dateCreated, and restores defaults for omitted fields', async () => {
            var user = await createUser({ name: 'Ada' });
            var task = await createTask({
                name: 'Draft',
                description: 'long notes',
                deadline: DEADLINE,
                assignedUser: user._id,
                assignedUserName: 'Ada'
            });
            var res = await request(app).put('/api/tasks/' + task._id).send({
                name: 'Final',
                deadline: '2026-06-01T00:00:00.000Z',
                dateCreated: '1999-01-01T00:00:00.000Z'
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.data.name, 'Final');
            assert.equal(res.body.data.description, '');
            assert.equal(res.body.data.completed, false);
            assert.equal(res.body.data.assignedUser, '');
            assert.equal(res.body.data.assignedUserName, 'unassigned');
            assert.equal(res.body.data.dateCreated, task.dateCreated);
            assert.deepEqual((await getUser(user._id)).pendingTasks, []);
        });

        it('deletes a task and removes it from pendingTasks', async () => {
            var user = await createUser();
            var task = await createTask({ assignedUser: user._id });
            var res = await request(app).delete('/api/tasks/' + task._id);
            assert.equal(res.status, 204);
            assert.equal(res.text, '');
            assert.deepEqual((await getUser(user._id)).pendingTasks, []);
            assertError(await request(app).get('/api/tasks/' + task._id), 404);
        });
    });

    describe('two-way references', () => {
        it('assigns pending tasks from POST /users and dedupes ids', async () => {
            var first = await createTask({ name: 'first' });
            var second = await createTask({ name: 'second' });
            var user = await createUser({
                name: 'Ada',
                pendingTasks: [first._id.toUpperCase(), first._id, second._id]
            });
            assert.deepEqual(user.pendingTasks, [first._id, second._id]);
            assert.deepEqual((await getUser(user._id)).pendingTasks, [first._id, second._id]);
            assert.equal((await getTask(first._id)).assignedUser, user._id);
            assert.equal((await getTask(first._id)).assignedUserName, 'Ada');
            assert.equal((await getTask(second._id)).assignedUser, user._id);
        });

        it('moves a task onto another user when that user lists it', async () => {
            var ada = await createUser({ name: 'Ada' });
            var grace = await createUser({ name: 'Grace' });
            var task = await createTask({ assignedUser: ada._id });
            var extra = await createTask({ assignedUser: ada._id });

            var res = await request(app).put('/api/users/' + grace._id).send({
                name: 'Grace Hopper',
                email: grace.email,
                pendingTasks: [task._id]
            });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.pendingTasks, [task._id]);

            var adaAfter = await getUser(ada._id);
            assert.deepEqual(adaAfter.pendingTasks, [extra._id]);
            var moved = await getTask(task._id);
            assert.equal(moved.assignedUser, grace._id);
            assert.equal(moved.assignedUserName, 'Grace Hopper');
            assert.equal((await getTask(extra._id)).assignedUser, ada._id);
        });

        it('unassigns tasks removed from pendingTasks and keeps completed tasks assigned when the name changes', async () => {
            var user = await createUser({ name: 'Ada' });
            var pending = await createTask({ name: 'pending', assignedUser: user._id });
            var staying = await createTask({ name: 'staying', assignedUser: user._id });
            var completed = await createTask({
                name: 'done',
                assignedUser: user._id,
                assignedUserName: 'Ada',
                completed: true
            });
            assert.deepEqual((await getUser(user._id)).pendingTasks.sort(), [pending._id, staying._id].sort());
            assert.deepEqual((await getUser(user._id)).pendingTasks.includes(completed._id), false);

            var renamed = await request(app).put('/api/users/' + user._id).send({
                name: 'Augusta',
                email: user.email,
                pendingTasks: [staying._id]
            });
            assert.equal(renamed.status, 200);
            assert.equal(renamed.body.data.dateCreated, user.dateCreated);
            assert.deepEqual(renamed.body.data.pendingTasks, [staying._id]);

            var dropped = await getTask(pending._id);
            assert.equal(dropped.assignedUser, '');
            assert.equal(dropped.assignedUserName, 'unassigned');
            var kept = await getTask(staying._id);
            assert.equal(kept.assignedUser, user._id);
            assert.equal(kept.assignedUserName, 'Augusta');
            var done = await getTask(completed._id);
            assert.equal(done.completed, true);
            assert.equal(done.assignedUser, user._id);
            assert.equal(done.assignedUserName, 'Augusta');

            var cleared = await request(app).put('/api/users/' + user._id).send({
                name: 'Augusta',
                email: user.email
            });
            assert.equal(cleared.status, 200);
            assert.deepEqual(cleared.body.data.pendingTasks, []);
            assert.equal((await getTask(staying._id)).assignedUser, '');
            var stillDone = await getTask(completed._id);
            assert.equal(stillDone.assignedUser, user._id);
            assert.equal(stillDone.assignedUserName, 'Augusta');
        });

        it('rejects completed or missing tasks in pendingTasks without writing', async () => {
            var user = await createUser({ name: 'Ada' });
            var pending = await createTask({ assignedUser: user._id });
            var completed = await createTask({
                assignedUser: user._id,
                assignedUserName: 'Ada',
                completed: true
            });

            var completedRes = await request(app).put('/api/users/' + user._id).send({
                name: 'Ada',
                email: user.email,
                pendingTasks: [pending._id, completed._id]
            });
            assertError(completedRes, 400);

            var missingRes = await request(app).post('/api/users').send({
                name: 'Grace',
                email: 'grace@example.com',
                pendingTasks: [pending._id, new mongoose.Types.ObjectId().toString()]
            });
            assertError(missingRes, 404);

            var malformedRes = await request(app).put('/api/users/' + user._id).send({
                name: 'Ada',
                email: user.email,
                pendingTasks: ['not-an-id', new mongoose.Types.ObjectId().toString()]
            });
            assertError(malformedRes, 400);

            var stored = await getUser(user._id);
            assert.equal(stored.name, 'Ada');
            assert.deepEqual(stored.pendingTasks, [pending._id]);
            assert.equal((await getTask(pending._id)).assignedUser, user._id);
            assert.equal((await getTask(completed._id)).assignedUser, user._id);
            assert.equal(await User.countDocuments({ email: 'grace@example.com' }), 0);
        });

        it('checks a duplicate email before a missing task id', async () => {
            var user = await createUser({ email: 'ada@example.com' });
            var res = await request(app).post('/api/users').send({
                name: 'Other',
                email: 'ada@example.com',
                pendingTasks: [new mongoose.Types.ObjectId().toString()]
            });
            assertError(res, 400);
            assert.equal(await User.countDocuments(), 1);
            assert.equal(user.email, 'ada@example.com');
        });

        it('does not add a completed task to pendingTasks and can reassign it', async () => {
            var ada = await createUser({ name: 'Ada' });
            var grace = await createUser({ name: 'Grace' });
            var task = await createTask({
                assignedUser: ada._id,
                assignedUserName: 'Ada',
                completed: true
            });
            assert.deepEqual((await getUser(ada._id)).pendingTasks, []);
            assert.equal(task.assignedUser, ada._id);
            assert.equal(task.assignedUserName, 'Ada');

            var moved = await request(app).put('/api/tasks/' + task._id).send({
                name: task.name,
                deadline: task.deadline,
                completed: true,
                assignedUser: grace._id,
                assignedUserName: 'Grace'
            });
            assert.equal(moved.status, 200);
            assert.equal(moved.body.data.assignedUser, grace._id);
            assert.equal(moved.body.data.assignedUserName, 'Grace');
            assert.equal(moved.body.data.completed, true);
            assert.equal(moved.body.data.dateCreated, task.dateCreated);
            assert.deepEqual((await getUser(ada._id)).pendingTasks, []);
            assert.deepEqual((await getUser(grace._id)).pendingTasks, []);
        });

        it('updates pendingTasks when a task is completed, reopened, reassigned, or unassigned', async () => {
            var ada = await createUser({ name: 'Ada' });
            var grace = await createUser({ name: 'Grace' });
            var task = await createTask({
                name: 'Essay',
                description: 'draft',
                assignedUser: ada._id,
                assignedUserName: 'Ada'
            });

            var completed = await request(app).put('/api/tasks/' + task._id).send({
                name: 'Essay',
                description: 'draft',
                deadline: task.deadline,
                completed: true,
                assignedUser: ada._id,
                assignedUserName: 'Ada'
            });
            assert.equal(completed.status, 200);
            assert.equal(completed.body.data.completed, true);
            assert.equal(completed.body.data.assignedUser, ada._id);
            assert.deepEqual((await getUser(ada._id)).pendingTasks, []);

            var reopened = await request(app).put('/api/tasks/' + task._id).send({
                name: 'Essay',
                description: 'draft',
                deadline: task.deadline,
                completed: false,
                assignedUser: ada._id
            });
            assert.equal(reopened.status, 200);
            assert.equal(reopened.body.data.assignedUserName, 'Ada');
            assert.deepEqual((await getUser(ada._id)).pendingTasks, [task._id]);

            var reassigned = await request(app).put('/api/tasks/' + task._id).send({
                name: 'Essay',
                description: 'draft',
                deadline: task.deadline,
                completed: false,
                assignedUser: grace._id,
                assignedUserName: 'Grace'
            });
            assert.equal(reassigned.status, 200);
            assert.deepEqual((await getUser(ada._id)).pendingTasks, []);
            assert.deepEqual((await getUser(grace._id)).pendingTasks, [task._id]);
            assert.equal((await getTask(task._id)).assignedUserName, 'Grace');

            var unassigned = await request(app).put('/api/tasks/' + task._id).send({
                name: 'Essay',
                description: 'draft',
                deadline: task.deadline,
                completed: false,
                assignedUser: ''
            });
            assert.equal(unassigned.status, 200);
            assert.equal(unassigned.body.data.assignedUser, '');
            assert.equal(unassigned.body.data.assignedUserName, 'unassigned');
            assert.deepEqual((await getUser(grace._id)).pendingTasks, []);
        });

        it('completes and reassigns a task in one replacement', async () => {
            var ada = await createUser({ name: 'Ada' });
            var grace = await createUser({ name: 'Grace' });
            var task = await createTask({ assignedUser: ada._id });
            var res = await request(app).put('/api/tasks/' + task._id).send({
                name: 'Done elsewhere',
                deadline: DEADLINE,
                completed: true,
                assignedUser: grace._id
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.data.assignedUser, grace._id);
            assert.equal(res.body.data.assignedUserName, 'Grace');
            assert.equal(res.body.data.completed, true);
            assert.deepEqual((await getUser(ada._id)).pendingTasks, []);
            assert.deepEqual((await getUser(grace._id)).pendingTasks, []);
        });

        it('round-trips a GET document through PUT without changing dateCreated', async () => {
            var user = await createUser({ name: 'Ada' });
            var task = await createTask({
                description: 'notes',
                assignedUser: user._id,
                assignedUserName: 'Ada'
            });
            var fetched = await getTask(task._id);
            var body = Object.assign({}, fetched);
            delete body._id;
            delete body.__v;
            delete body.dateCreated;
            var put = await request(app).put('/api/tasks/' + task._id).send(body);
            assert.equal(put.status, 200);
            assert.equal(put.body.data.dateCreated, task.dateCreated);
            assert.equal(put.body.data.description, 'notes');
            assert.deepEqual((await getUser(user._id)).pendingTasks, [task._id]);

            var fetchedUser = await getUser(user._id);
            var userBody = Object.assign({}, fetchedUser);
            delete userBody._id;
            delete userBody.__v;
            delete userBody.dateCreated;
            var putUser = await request(app).put('/api/users/' + user._id).send(userBody);
            assert.equal(putUser.status, 200);
            assert.equal(putUser.body.data.dateCreated, user.dateCreated);
            assert.deepEqual(putUser.body.data.pendingTasks, [task._id]);
            assert.equal((await getTask(task._id)).assignedUserName, 'Ada');
        });

        it('unassigns every task, including completed ones, when the user is deleted', async () => {
            var user = await createUser({ name: 'Ada' });
            var pending = await createTask({ assignedUser: user._id });
            var completed = await createTask({
                assignedUser: user._id,
                assignedUserName: 'Ada',
                completed: true
            });
            var res = await request(app).delete('/api/users/' + user._id);
            assert.equal(res.status, 204);
            assert.equal(res.text, '');
            var pendingAfter = await getTask(pending._id);
            var completedAfter = await getTask(completed._id);
            assert.equal(pendingAfter.assignedUser, '');
            assert.equal(pendingAfter.assignedUserName, 'unassigned');
            assert.equal(completedAfter.assignedUser, '');
            assert.equal(completedAfter.assignedUserName, 'unassigned');
            assertError(await request(app).get('/api/users/' + user._id), 404);
        });
    });

    describe('request errors', () => {
        it('rejects an invalid JSON body and an array body', async () => {
            var invalid = await request(app)
                .post('/api/users')
                .set('Content-Type', 'application/json')
                .send('{"name":');
            assertError(invalid, 400);

            var arrayBody = await request(app).post('/api/tasks').send([1, 2, 3]);
            assertError(arrayBody, 400);
        });

        it('keeps the starter API root response', async () => {
            var res = await request(app).get('/api');
            assert.equal(res.status, 200);
            assert.equal(typeof res.body.message, 'string');
        });
    });
});
