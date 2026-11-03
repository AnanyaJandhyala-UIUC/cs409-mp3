// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

mongoose.set('strictQuery', false);

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

app.use(function (err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }
    if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
        return res.status(400).json({
            message: 'Invalid JSON body',
            data: null
        });
    }
    console.error(err);
    return res.status(500).json({
        message: 'Internal server error',
        data: null
    });
});

// Connect to MongoDB and listen when started with `npm start`.
// Tests import this app and open their own database connection.
if (require.main === module) {
    mongoose.connect(process.env.MONGODB_URI).catch(function (err) {
        console.error('MongoDB connection error:', err.message);
    });

    app.listen(port);
    console.log('Server running on port ' + port);
}

module.exports = app;
