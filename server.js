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
	this.access = [];
	this.registeredEventHandlers = [];
}
util.inherits(ConnectionData, events.EventEmitter);

ConnectionData.prototype.client_insertPSEmail = function(query, cb) {
	UserDB.insertPSEmail(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
}

ConnectionData.prototype.client_list_schools = function(query, cb) {
	UserDB.listSchools(query, this.user, this.access, _.bind(function(results) {
		cb('list-schools-success', {'result': results});
	}, this));
}

ConnectionData.prototype.client_register = function(query, cb) {
	if (this.user !== null)
		cb('already-logged-in');
	else UserDB.register(query, this.user, this.access, _.bind(function(code, uid) {
		cb(code, {'uid': uid});
	}, this));
}

function _login (f) { return function(query, cb) {
	if (this.user === null)
		cb('not-logged-in')
	else
		return _.bind(f,this)(query, cb);
}}

ConnectionData.prototype.client_get_own_options = _login(function(query, cb) {
	cb('own-options-success', {'data': this.user});
})

ConnectionData.prototype.client_change_options = _login(function(query, cb) {
	UserDB.changeOptions(query, this.user, this.access, _.bind(function(code) {
		cb(code, {'is-reply-to': query.id});
	}, this));
})

ConnectionData.prototype.client_emailverif = function(query, cb) {
	UserDB.emailVerify(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
}

ConnectionData.prototype.client_login = function(query, cb) {
	UserDB.login(query, this.user, this.access, _.bind(function(code, key) {
		cb(code, {key:key});
	}, this));
}

ConnectionData.prototype.client_logout = _login(function(query, cb) {
	UserDB.logout(query, this.user, this.access, _.bind(function(code, key) {
		cb('logout-success');
		this.user = null;
		this.access = [];
	}, this));
})

ConnectionData.prototype.client_delete_user = _login(function(query, cb) {
	UserDB.deleteUser(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
})

ConnectionData.prototype.client_stock_search = _login(function(query, cb) {
	StocksDB.searchStocks(query, this.user, this.access, _.bind(function(code,results) {
		cb(code, {'results': results});
	}, this));
})

ConnectionData.prototype.client_stock_buy = _login(function(query, cb) {
	StocksDB.buyStock(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
})

ConnectionData.prototype.response = function(data) {
	this.emit('response', data);
}

ConnectionData.prototype.query = function(query) {
	var fetchedUser = _.bind(function(user) {
		var access = [];
		if (user != null)
			access = user.access.split(',');
		
		this.access = _.union(access, this.access);
			
		if (query.authorizationKey == authorizationKey) {
			this.access.push('*');
			if (user == null && query.uid != null)
				user = {uid: query.uid, id: query.uid};
			this.user = user;
		} else {
			if (user != null) 
				this.user = user;
		}
		
		var cb = _.bind(function(code, obj) {
			obj = obj || {};
			obj['code'] = code;
			obj['is-reply-to'] = query.id;
			this.response(obj);
		}, this);
		
		var t = query.type.replace(/-/, '_');
		if (('client_' + t) in this)
			_.bind(this['client_' + t], this)(query, cb);
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
