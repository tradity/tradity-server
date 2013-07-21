(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var sio = require('socket.io');
var assert = require('assert');
var nodemailer = require('nodemailer');
var fs = require('fs');

var cfg = require('./config.js').config;
var usr = require('./user.js');
var stocks = require('./stocks.js');
var eh_ = require('./errorhandler.js');
var db_ = require('./dbbackend.js');
var yf = require('./yahoofinance.js');

if (!fs.existsSync('./config.local.js')) {
	fs.writeFile('./config.local.js', 'exports.config={};\n', function() {});
} else {
	var cfgl = require('./config.local.js').config;
	for (var i in cfgl)	
		cfg[i] = cfgl[i];
}

var yfql = new yf.YahooFinanceQuoteLoader();
var mailer = nodemailer.createTransport(cfg.mail.transport, cfg.mail.transportData);
var eh = new eh_.ErrorHandler(cfg, mailer);
var db = new db_.Database(cfg);
var UserDB = new usr.UserDB(db);
var StocksDB = new stocks.StocksDB(db, yfql);

yfql.on('error', function(e) { eh.err(e); });
db.on('error', function(e) { eh.err(e); });
UserDB.on('error', function(e) { eh.err(e); });
StocksDB.on('error', function(e) { eh.err(e); });

setInterval(function() {
	UserDB.regularCallback();
}, 60 * 1000);
setInterval(function() {
	StocksDB.regularCallback();
}, 240 * 1000);

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

ConnectionData.prototype.client_get_own_options = function(query) {
	UserDB.getUserData(query.key, _.bind(function(data) {
		if (data.code === null) {
			this.response({'code': 'not-logged-in', 'is-reply-to': query.id});
		} else {
			this.response({'code': 'own-options-success', 'is-reply-to': query.id, 'data': data});
		}
	}, this));
}

ConnectionData.prototype.client_change_options = function(query) {
	UserDB.changeOptions(query, mailer, cfg, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_emailverif = function(query) {
	UserDB.emailVerify(query.uid, query.key, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_login = function(query) {
	UserDB.login(query.name, query.pw, query.stayloggedin, _.bind(function(code, key) {
		this.response({'code': code, 'is-reply-to': query.id, 'key': key});
	}, this));
}

ConnectionData.prototype.client_logout = function(query) {
	UserDB.logout(query.key);
}

ConnectionData.prototype.client_stock_search = function(query) {
	StocksDB.searchStocks(query.name, _.bind(function(code,results) {
		this.response({'code': code, 'results': results});
	}, this));
}

ConnectionData.prototype.response = function(data) {
	this.emit('response', data);
}

ConnectionData.prototype.query = function(query) {
	var t = query.type.replace(/-/, '_');
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

var server = require('http').createServer();
server.on('request', function (req, res) {
	res.writeHead(200);
	res.end('Hi!');
});
server.listen(cfg.wsport, 'localhost');
var io = sio.listen(server);

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
