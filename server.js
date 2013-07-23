(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var sio = require('socket.io');
var assert = require('assert');
var nodemailer = require('nodemailer');
var fs = require('fs');
var crypto = require('crypto');

var cfg = require('./config.js').config;
var usr = require('./user.js');
var stocks = require('./stocks.js');
var eh_ = require('./errorhandler.js');
var db_ = require('./dbbackend.js');
var yf = require('./yahoofinance.js');

if (!fs.existsSync('./config.local.js')) {
	fs.writeFile('./config.local.js', 'exports.config={};\n', {mode: 432}, function() {});
} else {
	var cfgl = require('./config.local.js').config;
	for (var i in cfgl)	
		cfg[i] = cfgl[i];
}

crypto.randomBytes(64, _.bind(function(ex, buf) {
var authorizationKey = buf.toString('hex');
fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});

var yfql = new yf.YahooFinanceQuoteLoader();
var mailer = nodemailer.createTransport(cfg.mail.transport, cfg.mail.transportData);
var eh = new eh_.ErrorHandler(cfg, mailer);
var db = new db_.Database(cfg);
var UserDB = new usr.UserDB(db, mailer, cfg);
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

ConnectionData.prototype.client_insertPSEmail = function(query, user, access) {
	UserDB.insertPSEmail(query, user, access, _.bind(function(code) {
		this.response({'code' : code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_list_schools = function(query, user, access) {
	UserDB.listSchools(query, user, access, _.bind(function(results) {
		this.response({'code' : 'list-schools-success', 'is-reply-to': query.id, 'result': results});
	}, this));
}

ConnectionData.prototype.client_register = function(query, user, access) {
	if (user !== null)
		this.response({'code': 'already-logged-in', 'is-reply-to': query.id});
	else UserDB.register(query, user, access, _.bind(function(code, uid) {
		this.response({'code': code, 'is-reply-to': query.id, 'uid': uid});
	}, this));
}

ConnectionData.prototype.client_get_own_options = function(query, user, access) {
	if (user === null) 
		this.response({'code': 'not-logged-in', 'is-reply-to': query.id});
	else
		this.response({'code': 'own-options-success', 'is-reply-to': query.id, 'data': user});
}

ConnectionData.prototype.client_change_options = function(query, user, access) {
	if (user === null) 
		this.response({'code': 'not-logged-in', 'is-reply-to': query.id});
	else UserDB.changeOptions(query, user, access, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_emailverif = function(query, user, access) {
	UserDB.emailVerify(query, user, access, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_login = function(query, user, access) {
	UserDB.login(query, user, access, _.bind(function(code, key) {
		this.response({'code': code, 'is-reply-to': query.id, 'key': key});
	}, this));
}

ConnectionData.prototype.client_logout = function(query, user, access) {
	if (user === null)
		this.response({'code': 'not-logged-in', 'is-reply-to': query.id});
	else UserDB.logout(query, user, access, _.bind(function(code, key) {
		this.response({'code': 'logout-success', 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_delete_user = function(query, user, access) {
	if (user === null)
		this.response({'code': 'not-logged-in', 'is-reply-to': query.id});
	else UserDB.deleteUser(query, user, access, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_stock_search = function(query, user, access) {
	if (user === null)
		this.response({'code': 'not-logged-in', 'is-reply-to': query.id});
	else StocksDB.searchStocks(query, user, access, _.bind(function(code,results) {
		this.response({'code': code, 'results': results, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.client_stock_buy = function(query, user, access) {
	if (user === null)
		this.response({'code': 'not-logged-in', 'is-reply-to': query.id});
	else StocksDB.buyStock(query, user, access, _.bind(function(code) {
		this.response({'code': code, 'is-reply-to': query.id});
	}, this));
}

ConnectionData.prototype.response = function(data) {
	this.emit('response', data);
}

ConnectionData.prototype.query = function(query) {
	var fetchedUser = _.bind(function(usr) {
		var access = [];
		if (usr != null)
			access = usr.access.split(',');
			
		if (query.authorizationKey == authorizationKey) {
			access = ['*'];
			if (usr == null && query.uid != null)
				usr = {uid: query.uid, id: query.uid};
		}
		
		var t = query.type.replace(/-/, '_');
		if (('client_' + t) in this)
			_.bind(this['client_' + t], this)(query, usr, access);
		else
			this.response('unknown-query-type');
	}, this);
	
	if (query.key != null)
		UserDB.loadSessionUser(query.key, fetchedUser);
	else
		fetchedUser(null);
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

}, this));
})();
