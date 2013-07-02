(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var sio = require('socket.io');
var assert = require('assert');

var cfg = require('./config.js').config;
var obj = require('./objects.js');
var db_ = require('./dbbackend.js');

var db = new db_.Database(cfg);
var UserDB = new obj.UserDB(db);

function ConnectionData() {
	this.user = null;
	this.registeredEventHandlers = [];
}
util.inherits(ConnectionData, events.EventEmitter);

ConnectionData.prototype.client_insertPSEmail = function(query) {
	UserDB.insertPSEmail(query.email, _.bind(function(alreadyPresent, success) {
		if (alreadyPresent)
			this.response({'code' : 'email-already-present'});
		else if (success)
			this.response({'code' : 'email-enter-success'});
	}, this));
}

ConnectionData.prototype.response = function(data) {
	this.emit('response', data);
}

ConnectionData.prototype.query = function(query) {
	var t = query.type;
	if (('client_' + t) in this)
		_.bind(this['client_' + t], this)(query);
	else
		this.emit('error', new Error('No such query type known: ' + t));
}

ConnectionData.prototype.regListenerBoundEx = function(obj, event, fn) {
	this.registeredEventHandlers.push([obj, event, fn]);
	obj.addListener(event, _.bind(fn, this));
}

ConnectionData.prototype.disconnected = function() {
	for (var i = 0; i < this.registeredEventHandlers.length; ++i) {
		var e = this.registeredEventHandlers[i];
		e[0].removeListener(e[1], e[2]);
	}
}

var io = sio.listen(cfg.wsport);
io.sockets.on('connection', function(socket) {
	var d = new ConnectionData();
	
	d.on('response', function(data) {
		socket.emit('response', data);
	});
	
	d.on('error', function(data) {
		socket.emit('error', data);
	});
	
	socket.on('query', function(query) {
		d.query(query);
	});
	
	socket.on('disconnect', function() {
		d.disconnected();
	});
});

})();
