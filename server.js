(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var sio = require('socket.io');
var assert = require('assert');
var nodemailer = require('nodemailer');

var cfg = require('./config.js').config;
var obj = require('./objects.js');
var eh_ = require('./errorhandler.js');
var db_ = require('./dbbackend.js');

var mailer = nodemailer.createTransport(cfg.mail.transport, cfg.mail.transportData);
var eh = new eh_.ErrorHandler(cfg, mailer);
var db = new db_.Database(cfg);
db.on('error', function(e) { eh.err(e); });
var UserDB = new obj.UserDB(db);
UserDB.on('error', function(e) { eh.err(e); });

function ConnectionData() {
	this.user = null;
	this.registeredEventHandlers = [];
}
util.inherits(ConnectionData, events.EventEmitter);

ConnectionData.prototype.client_insertPSEmail = function(query) {
	UserDB.insertPSEmail(query.email, _.bind(function(code) {
		this.response({'code' : code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_register = function(query) {
	UserDB.register(query, mailer, cfg, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_emailverif = function(query) {
	UserDB.emailVerify(query.uid, query.key, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
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
	d.on('error', function(e) { eh.err(e); });
	
	d.on('response', function(data) {
		socket.emit('response', data);
	});
	
	d.on('error', function(data) {
		socket.emit('error', data);
	});
	
	socket.on('query', function(query) {
		try {
			d.query(query);
		} catch (e) {
			eh.err(e);
		}
	});
	
	socket.on('disconnect', function() {
		try {
			d.disconnected();
		} catch (e) {
			eh.err(e);
		}
	});
});

})();
