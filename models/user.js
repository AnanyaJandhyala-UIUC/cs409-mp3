var mongoose = require('mongoose');

var UserSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true
        },
        email: {
            type: String,
            required: true,
            unique: true
        },
        pendingTasks: {
            type: [String],
            default: []
        },
        // Set on create and left unchanged by updates. Client values are ignored.
        dateCreated: {
            type: Date,
            default: Date.now,
            immutable: true
        }
    },
    { id: false }
);

module.exports = mongoose.model('User', UserSchema);
