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
var adm = require('./admin.js');
var stocks = require('./stocks.js');
var fsdb = require('./fsdb.js');
var dqueries = require('./dqueries.js');
var eh_ = require('./errorhandler.js');
var db_ = require('./dbbackend.js');
var af = require('./arivafinance.js');
var locking = require('./locking.js');
var Access = require('./access.js').Access;

crypto.randomBytes(64, _.bind(function(ex, buf) {
var authorizationKey = buf.toString('hex');
fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});

var afql = new af.ArivaFinanceQuoteLoader();
var mailer = nodemailer.createTransport(cfg.mail.transport, cfg.mail.transportData);
var eh = new eh_.ErrorHandler(cfg, mailer);
var db = new db_.Database(cfg);
var UserDB = new usr.UserDB(db, mailer, cfg);
var AdminDB = new adm.AdminDB(db, cfg);
var StocksDB = new stocks.StocksDB(db, cfg, afql);
var FileStorageDB = new fsdb.FileStorageDB(db, cfg);
var dqDB = new dqueries.DelayedQueriesDB(db, cfg, StocksDB);

var subsystems = [StocksDB, UserDB, AdminDB, dqDB, FileStorageDB];
_.each(subsystems, _.bind(function(sys) { sys.on('error', function(e) { eh.err(e); }); }));

afql.on('error', function(e) { eh.err(e); });
db.on('error', function(e) { eh.err(e); });
locking.Lock.globalLockAuthority.on('error', function(e) { eh.err(e); });

function ConnectionData(socket) {
	this.user = null;
	this.remoteip = socket.handshake.address.address;
	this.hsheaders = socket.handshake.headers;
	this.cdid = new Date().getTime() + '-' + this.remoteip + '-' + ConnectionData.uniqueCount++;
	this.access = new Access();
	this.registeredEventHandlers = [];
	this.pushEventsTimer = null;
	this.lastInfoPush = 0;
	this.mostRecentEventTime = 0;
	
	_.each(subsystems, _.bind(function(sys) {
		this.regListenerBoundEx(sys, 'push', this.push);
		this.regListenerBoundEx(sys, 'push-events', this.pushEvents);
	}, this));
}
util.inherits(ConnectionData, events.EventEmitter);

ConnectionData.uniqueCount = 0;

ConnectionData.prototype.client_insertPSEmail = function(query, cb) {
	UserDB.insertPSEmail(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
}

function _login (f) {
	return function(query, cb) {
		if (this.user === null && !this.access.has('login-override'))
			cb('not-logged-in')
		else
			return _.bind(f,this)(query, cb);
	};
}

ConnectionData.prototype.client_get_ranking = _login(function(query, cb) {
	UserDB.getRanking(query, this.user, this.access, _.bind(function(results, count) {
		cb('get-ranking-success', {'result': results, 'count': count});
	}, this));
});

ConnectionData.prototype.client_get_user_info = _login(function(query, cb) {
	UserDB.getUserInfo(query, this.user, this.access, _.bind(function(user, orders, values, pinboard) {
		if (!user)
			cb('get-user-info-notfound');
		else
			cb('get-user-info-success', {'result': user, 'orders': orders, 'values': values, 'pinboard': pinboard});
	}, this));
});

ConnectionData.prototype.client_list_schools = function(query, cb) {
	UserDB.listSchools(query, this.user, this.access, _.bind(function(results) {
		cb('list-schools-success', {'result': results});
	}, this));
};

ConnectionData.prototype.client_password_reset = function(query, cb) {
	if (this.user !== null)
		cb('already-logged-in');
	else UserDB.passwordReset(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
};

ConnectionData.prototype.client_register = function(query, cb) {
	if (this.user !== null)
		cb('already-logged-in');
	else UserDB.register(query, this.user, this.access, _.bind(function(code, uid) {
		cb(code, {'uid': uid});
	}, this));
};

ConnectionData.prototype.client_prod = function(query, cb) {
	if (!this.access || this.access.has('server') == -1) {
		cb('prod-not-allowed');
	} else {
		var starttime = new Date().getTime();
		UserDB.regularCallback(function() {
			var userdbtime = new Date().getTime();
			StocksDB.regularCallback(query, function() {
				cb('prod-ready', {'utime': userdbtime - starttime, 'stime': new Date().getTime() - userdbtime});
			});
		});
	}
};

ConnectionData.prototype.client_get_own_options = _login(function(query, cb) {
	var r = _.clone(this.user);
	delete r.pwhash;
	delete r.pwsalt;
	cb('own-options-success', {'result': r});
});

ConnectionData.prototype.client_change_options = _login(function(query, cb) {
	UserDB.changeOptions(query, this.user, this.access, _.bind(function(code) {
		cb(code, {'is-reply-to': query.id});
	}, this));
});

ConnectionData.prototype.client_emailverif = function(query, cb) {
	UserDB.emailVerify(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
};

ConnectionData.prototype.client_login = function(query, cb) {
	UserDB.login(query, this.user, this.access, this, _.bind(function(code, key) {
		this.pushEvents();
		cb(code, {key:key});
	}, this));
};

ConnectionData.prototype.client_logout = _login(function(query, cb) {
	UserDB.logout(query, this.user, this.access, _.bind(function(code, key) {
		cb('logout-success');
		this.user = null;
		this.access = new Access();
	}, this));
});

ConnectionData.prototype.client_reset_user = _login(function(query, cb) {
	UserDB.resetUser(query, this.user, this.access, StocksDB, _.bind(function(code) {
		dqDB.resetUser(query, this.user, this.access, _.bind(function() {
			cb(code);
		}), this);
	}, this));
});

ConnectionData.prototype.client_stock_search = _login(function(query, cb) {
	StocksDB.searchStocks(query, this.user, this.access, _.bind(function(code,results) {
		cb(code, {'results': results});
	}, this));
});

ConnectionData.prototype.client_stock_buy = _login(function(query, cb) {
	StocksDB.buyStock(query, this.user, this.access, _.bind(function(code, fee, tradeID) {
		cb(code, fee ? {'fee': fee, 'tradeid': tradeID} : null);
	}, this));
});

ConnectionData.prototype.client_comment = _login(function(query, cb) {
	StocksDB.commentEvent(query, this.user, this.access, cb);
});

ConnectionData.prototype.client_list_own_depot = _login(function(query, cb) {
	StocksDB.stocksForUser(this.user, _.bind(function(results) {
		cb('list-own-depot-success', {'results': results});
	}, this));
});

ConnectionData.prototype.client_get_trade_info = _login(function(query, cb) {
	StocksDB.getTradeInfo(query, this.user, this.access, function(code, trade, comments) {
		cb(code, trade ? {'trade': trade, 'comments': comments} : null);
	});
});

ConnectionData.prototype.client_watchlist_add = _login(function(query, cb) {
	UserDB.watchlistAdd(query, this.user, this.access, cb);
});

ConnectionData.prototype.client_watchlist_remove = _login(function(query, cb) {
	UserDB.watchlistRemove(query, this.user, this.access, cb);
});

ConnectionData.prototype.client_watchlist_show = _login(function(query, cb) {
	UserDB.watchlistShow(query, this.user, this.access, function(res) {
		cb('watchlist-show-success', {'results':res});
	});
});

ConnectionData.prototype.client_list_all_users = _login(function(query, cb) {
	AdminDB.listAllUsers(query, this.user, this.access, _.bind(function(code, res) {
		cb(code, {'results':res});
	}, this));
});

ConnectionData.prototype.client_impersonate_user = _login(function(query, cb) {
	AdminDB.impersonateUser(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_delete_user = _login(function(query, cb) {
	AdminDB.deleteUser(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_change_user_email = _login(function(query, cb) {
	AdminDB.changeUserEMail(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_change_comment_text = _login(function(query, cb) {
	AdminDB.changeCommentText(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_notify_all = _login(function(query, cb) {
	AdminDB.notifyAll(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_create_school = _login(function(query, cb) {
	AdminDB.createSchool(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_rename_school = _login(function(query, cb) {
	AdminDB.renameSchool(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_join_schools = _login(function(query, cb) {
	AdminDB.joinSchools(query, this.user, this.access, _.bind(function(code, res) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_ping = function(query, cb) {
	cb('pong', {'uid': this.user ? this.user.uid : null});
};

ConnectionData.prototype.client_fetch_events = _login(function(query, cb) {
	this.fetchEvents(query);
});

ConnectionData.prototype.client_dquery = _login(function(query, cb) {
	dqDB.addDelayedQuery(query, this.user, this.access, cb);
});

ConnectionData.prototype.client_dquery_list = _login(function(query, cb) {
	dqDB.listDelayQueries(query, this.user, this.access, cb);
});

ConnectionData.prototype.client_dquery_remove = _login(function(query, cb) {
	dqDB.removeQueryUser(query, this.user, this.access, cb);
});

ConnectionData.prototype.client_publish = _login(function(query, cb) {
	FileStorageDB.publish(query, this.user, this.access, cb);
});

ConnectionData.prototype.client_get_config = function(query, cb) {
	cb('get-config-success', {'config':_.pick(cfg, cfg.clientconfig)});
};

ConnectionData.prototype.fetchEvents = function(query) {
	if (!this.user)
		return; // no user – no events.
		
	// possibly push info 
	this.pushSelfInfo();
	
	// fetch regular events
	StocksDB.fetchEvents(query, this.user, this.access, _.bind(function(evlist) {
		_.each(evlist, _.bind(function(ev) {
			this.mostRecentEventTime = Math.max(this.mostRecentEventTime, ev.eventtime);
			this.emit('push', ev);
		}, this));
	}, this));
}

ConnectionData.prototype.push = function(data) {
	if (data.type != 'stock-update')
		this.emit('push', data);
	this.pushSelfInfo();
}

ConnectionData.prototype.pushSelfInfo = function() {
	if (!this.user)
		return;
	
	var curUnixTime = new Date().getTime();
	if (curUnixTime > this.lastInfoPush + cfg['infopush-mindelta']) {
		this.lastInfoPush = curUnixTime;
		UserDB.getUserInfo({lookfor:'$self', nohistory:true}, this.user, this.access, _.bind(function(info) {
			if (!info) // wtf?
				return this.emit('error', new Error('no user on $self in info push handler'));
			info.type = 'self-info';
			this.push(info);
		}, this));
	}
}

ConnectionData.prototype.pushEvents = function() {
	if (this.pushEventsTimer || !this.user || !this.user.uid)
		return;
	this.pushEventsTimer = setTimeout(_.bind(function() {
		this.pushEventsTimer = null;
		this.fetchEvents({since: this.mostRecentEventTime, count: null});
	}, this), 1000);
}

ConnectionData.prototype.response = function(data) {
	this.emit('response', data);
}

ConnectionData.prototype.query = function(query) {
	// sanitize by removing everything enclosed in '__'
	query = _.omit(query, _.chain(query).keys().filter(function(k) { return /^__.*__$/.test(k); }));
	
	var recvTime = new Date().getTime();
	
	UserDB.loadSessionUser(query.key, _.bind(function(user) {
		var access = new Access();
		if (user != null)
			access.update(Access.fromJSON(user.access));
		
		this.access.update(access);
			
		if (query.authorizationKey == authorizationKey) {
			console.log('Received query with master authorization of type', query.type);
			this.access.grantAny();
			if (user == null && query.uid != null)
				user = {uid: query.uid, id: query.uid};
		}
		 
		this.user = user;
		
		var cb = _.bind(function(code, obj) {
			var now = new Date().getTime();
			obj = obj || {};
			obj['code'] = code;
			obj['is-reply-to'] = query.id;
			obj['_t_sresp'] = now;
			obj['_t_srecv'] = recvTime;
			obj['_t_sdelta'] = now - recvTime;
			this.response(obj);
		}, this);
		
		var t = query.type.replace(/-/g, '_');
		if (('client_' + t) in this)
			_.bind(this['client_' + t], this)(query, cb);
		else
			this.response('unknown-query-type');
	}, this));
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
	if (!FileStorageDB.handle(req, res)) {
		res.writeHead(200);
		res.end('Hi (not really found)!');
	}
});
server.listen(cfg.wsport, 'localhost');
var io = sio.listen(server);

io.configure('production', function(){
	io.enable('browser client minification');
	io.enable('browser client etag');
	io.enable('browser client gzip');
	io.set('log level', 1);
});

io.sockets.on('connection', function(socket) {
	var d = new ConnectionData(socket);
	d.on('error', function(e) { eh.err(e); });
	
	d.on('response', function(data) {
		socket.emit('response', data);
	});
	
	d.on('push', function(data) {
		socket.emit('push', data);
	});
	
	d.on('error', function(data) {
		socket.emit('error', data);
	});
	
	socket.on('query', eh.wrap(function(query) {
		d.query(query);
	}));
	
	socket.on('disconnect', eh.wrap(function() {
		d.disconnected();
	}));
});

}, this));
})();
