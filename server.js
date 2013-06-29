(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var sio = require('socket.io');

var cfg = require('./config.js').config;
var objects = require('./objects.js');
var db_ = require('./dbbackend.js');

var db = new db_.Database(cfg);

function ConnectionData() {
}

ConnectionData.prototype.query = function(query) {
	
}

ConnectionData.prototype.disconnected = function() {
}

var io = sio.listen(cfg.wsport);
io.sockets.on('connection', function(socket) {
	var d = new ConnectionData();
	
	socket.on('query', function(query) {
		d.query(query);
	});
	
	socket.on('disconnect', function() {
		d.disconnected();
	});
});

})();
