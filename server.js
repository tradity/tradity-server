(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var sio = require('socket.io');
var assert = require('assert');
var nodemailer = require('nodemailer');
var fs = require('fs');
var crypto = require('crypto');
var url = require('url');
var spawn = require('child_process').spawn;

var cfg = require('./config.js').config;
var usr = require('./user.js');
var adm = require('./admin.js');
var sch = require('./schools.js');
var ach = require('./achievements.js');
var feedctrl = require('./feed.js');
var stocks = require('./stocks.js');
var fsdb = require('./fsdb.js');
var dqueries = require('./dqueries.js');
var eh_ = require('./errorhandler.js');
var db_ = require('./dbbackend.js');
var af = require('./arivafinance.js');
var locking = require('./locking.js');
var Access = require('./access.js').Access;
var AchievementList = require('./achievement-list.js').AchievementList;

crypto.randomBytes(64, _.bind(function(ex, buf) {
var authorizationKey = buf.toString('hex');
fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});

var afql = new af.ArivaFinanceQuoteLoader();
var mailer = nodemailer.createTransport(cfg.mail.transport, cfg.mail.transportData);
var eh = new eh_.ErrorHandler(cfg, mailer);
var db = new db_.Database(cfg);
var FeedControllerDB = new feedctrl.FeedControllerDB(db, cfg);
var UserDB = new usr.UserDB(db, mailer, cfg);
var AdminDB = new adm.AdminDB(db, cfg);
var SchoolsDB = new sch.SchoolsDB(db, cfg);
var StocksDB = new stocks.StocksDB(db, cfg, afql);
var FileStorageDB = new fsdb.FileStorageDB(db, cfg);
var AchievementsDB = new ach.AchievementsDB(db, cfg);
var dqDB = new dqueries.DelayedQueriesDB(db, cfg, StocksDB);

var subsystems = [FeedControllerDB, StocksDB, UserDB, AdminDB, SchoolsDB, dqDB, FileStorageDB, AchievementsDB];
_.each(subsystems, function(sys) {
	sys.on('error', function(e) { eh.err(e); });
	sys.setFeedController(FeedControllerDB);
});

AchievementsDB.registerAchievements(AchievementList);

afql.on('error', function(e) { eh.err(e); });
db.on('error', function(e) { eh.err(e); });
locking.Lock.globalLockAuthority.on('error', function(e) { eh.err(e); });

process.on('uncaughtException', function(err) {
	eh.err(err);
	
	setTimeout(function() {
		process.exit(1);
	}, 1000);
});

function ConnectionData(socket) {
	this.user = null;
	this.remoteip = socket.handshake.address.address;
	this.hsheaders = _.omit(socket.handshake.headers, ['authorization', 'proxy-authorization']);
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

ConnectionData.prototype.toString = function() {
	return JSON.stringify(_.pick(this, 'user', 'remoteip', 'hsheaders', 'cdid', 'access', 'lastInfoPush', 'mostRecentEventTime'));
};

ConnectionData.uniqueCount = 0;

function _login (f) {
	return function(query, cb) {
		if (this.user === null && !this.access.has('login_override'))
			cb('not-logged-in')
		else
			return _.bind(f,this)(query, cb);
	};
}

ConnectionData.prototype.client_get_ranking = _login(function(query, cb) {
	UserDB.getRanking(query, this.user, this.access, _.bind(function(results) {
		cb('get-ranking-success', {'result': results});
	}, this));
});

ConnectionData.prototype.client_get_user_info = _login(function(query, cb) {
	UserDB.getUserInfo(query, this.user, this.access, _.bind(function(user, orders, achievements, values, pinboard) {
		if (!user)
			cb('get-user-info-notfound');
		else
			cb('get-user-info-success', {'result': user, 'orders': orders, 'values': values, 'pinboard': pinboard, 'achievements': achievements});
	}, this));
});

ConnectionData.prototype.client_list_schools = function(query, cb) {
	SchoolsDB.listSchools(query, this.user, this.access, _.bind(function(results) {
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

ConnectionData.prototype.client_get_invitekey_info = function(query, cb) {
	UserDB.getInviteKeyInfo(query, this.user, this.access, _.bind(function(code, res) {
		cb(code, {'result': res});
	}, this));
};

ConnectionData.prototype.client_register = function(query, cb) {
	if (this.user !== null)
		cb('already-logged-in');
	else UserDB.register(query, this.user, this.access, this, _.bind(function(code, uid, key) {
		cb(code, {'uid': uid, 'key': key});
	}, this));
};

ConnectionData.prototype.client_prod = function(query, cb) {
	if (!this.access || this.access.has('server') == -1) {
		cb('prod-not-allowed');
	} else {
		var starttime = new Date().getTime();
		UserDB.regularCallback(query, function() {
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
	UserDB.changeOptions(query, this.user, this.access, this, _.bind(function(code) {
		cb(code, {'is-reply-to': query.id}, 'repush');
	}, this));
});

ConnectionData.prototype.client_emailverif = function(query, cb) {
	UserDB.emailVerify(query, this.user, this.access, this, _.bind(function(code, key) {
		this.pushEvents();
		cb(code, {key:key});
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
		this.user = null;
		this.access = new Access();
		cb('logout-success');
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

ConnectionData.prototype.client_list_popular_stocks = _login(function(query, cb) {
	UserDB.listPopularStocks(query, this.user, this.access, _.bind(function(code,results) {
		cb(code, {'results': results});
	}, this));
});

ConnectionData.prototype.client_stock_buy = _login(function(query, cb) {
	StocksDB.buyStock(query, this.user, this.access, _.bind(function(code, fee, tradeID) {
		cb(code, fee ? {'fee': fee, 'tradeid': tradeID} : null);
	}, this));
});

ConnectionData.prototype.client_comment = _login(function(query, cb) {
	FeedControllerDB.commentEvent(query, this.user, this.access, cb);
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

ConnectionData.prototype.client_eval_code = _login(function(query, cb) {
	AdminDB.evalCode(query, this.user, this.access, _.bind(function(code, res) {
		cb(code, {'result':res});
	}, this));
});

ConnectionData.prototype.client_list_all_users = _login(function(query, cb) {
	AdminDB.listAllUsers(query, this.user, this.access, _.bind(function(code, res) {
		cb(code, {'results':res});
	}, this));
});

ConnectionData.prototype.client_get_user_logins = _login(function(query, cb) {
	AdminDB.getUserLogins(query, this.user, this.access, _.bind(function(code, res) {
		cb(code, {'results':res});
	}, this));
});

ConnectionData.prototype.client_impersonate_user = _login(function(query, cb) {
	AdminDB.impersonateUser(query, this.user, this.access, _.bind(function(code) {
		cb(code, null, 'repush');
	}, this));
});

ConnectionData.prototype.client_delete_user = _login(function(query, cb) {
	AdminDB.deleteUser(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_change_user_email = _login(function(query, cb) {
	AdminDB.changeUserEMail(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_change_comment_text = _login(function(query, cb) {
	AdminDB.changeCommentText(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_notify_unstick_all = _login(function(query, cb) {
	AdminDB.notifyUnstickAll(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_notify_all = _login(function(query, cb) {
	AdminDB.notifyAll(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_create_school = _login(function(query, cb) {
	SchoolsDB.createSchool(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_create_invite_link = _login(function(query, cb) {
	SchoolsDB.createInviteLink(query, this.user, this.access, UserDB, _.bind(function(code, res) {
		cb(code, res);
	}, this));
});

ConnectionData.prototype.client_rename_school = _login(function(query, cb) {
	AdminDB.renameSchool(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_join_schools = _login(function(query, cb) {
	AdminDB.joinSchools(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_get_school_info = _login(function(query, cb) {
	SchoolsDB.getSchoolInfo(query, this.user, this.access, _.bind(function(code, res) {
		cb(code, {'result':res});
	}, this));
});

ConnectionData.prototype.client_school_change_description = _login(function(query, cb) {
	SchoolsDB.changeDescription(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_school_change_member_status = _login(function(query, cb) {
	SchoolsDB.changeMemberStatus(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_school_delete_comment = _login(function(query, cb) {
	SchoolsDB.deleteComment(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	}, this));
});

ConnectionData.prototype.client_school_kick_user = _login(function(query, cb) {
	SchoolsDB.kickUser(query, this.user, this.access, _.bind(function(code) {
		cb(code);
	},this));
});

ConnectionData.prototype.client_school_publish_banner = _login(function(query, cb) {
	SchoolsDB.publishBanner(query, this.user, this.access, FileStorageDB, _.bind(function(code) {
		cb(code);
	},this));
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
	FileStorageDB.publish(query, this.user, this.access, _.bind(function(code) {
		cb(code, null, 'repush');
	}, this));
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
	FeedControllerDB.fetchEvents(query, this.user, this.access, _.bind(function(evlist) {
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
};

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
};

ConnectionData.prototype.pushEvents = function() {
	if (this.pushEventsTimer || !this.user || !this.user.uid)
		return;
	this.pushEventsTimer = setTimeout(_.bind(function() {
		this.pushEventsTimer = null;
		this.fetchEvents({since: this.mostRecentEventTime, count: null});
	}, this), 1000);
};

ConnectionData.prototype.response = function(data) {
	this.emit('response', data);
};

ConnectionData.prototype.onUserConnected = function() {
	AchievementsDB.checkAchievements(this.user, this.access);
};

ConnectionData.prototype.query = function(query) {
	var recvTime = new Date().getTime();
	
	// sanitize by removing everything enclosed in '__'s
	var sanitizeQuery = function(q) {
		if (q.query)
			q.query = sanitizeQuery(q.query);
		
		return _.omit(q, _.chain(q).keys().filter(function(k) { return /^__.*__$/.test(k); }));
	};
	
	query = sanitizeQuery(query);
	
	var hadUser = this.user ? true : false;
	
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
		this.access[['grant', 'drop'][this.user && this.user.email_verif ? 0 : 1]]('email_verif');
		
		if (!hadUser && this.user != null)
			this.onUserConnected();
		
		var cb = _.bind(function(code, obj, extra) {
			var now = new Date().getTime();
			obj = obj || {};
			obj['code'] = code;
			obj['is-reply-to'] = query.id;
			obj['_t_sdone'] = now;
			obj['_t_srecv'] = recvTime;
			this.response(obj);
			
			if (extra && extra == 'repush') {
				this.lastInfoPush = 0;
				
				UserDB.loadSessionUser(query.key, _.bind(function(newUser) {
					if (newUser)
						this.user = newUser;
					
					this.pushSelfInfo();
				}, this));
			}
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
	var loc = url.parse(req.url, true);
	if (loc.pathname.match(/^(\/dynamic)?\/?ping/)) {
		res.writeHead(200, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
		res.end('pong');
		return;
	}
	
	if (!FileStorageDB.handle(req, res, loc)) {
		res.writeHead(404, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
		res.end('Hi (not really found)!');
	}
});
server.listen(cfg.wsport, cfg.wshost);
var io = sio.listen(server);

io.configure('production', function(){
	io.enable('browser client minification');
	io.enable('browser client etag');
	io.enable('browser client gzip');
	io.set('log level', 1);
});

var recentQueries = [];
var recentQueryCount = 128;
eh.getEnvironmentInformation = function() {
	return {
		recentQueries: recentQueries,
		recentDBQueries: db.getRecentQueries()
	};
};

io.sockets.on('connection', function(socket) {
	var d = new ConnectionData(socket);
	d.on('error', function(e) { eh.err(e); });
	
	var wrapForReply = function(obj, cb) {
		var s = JSON.stringify(obj);
		
		(s.length > 20480 ? function(cont) {
			var buflist = [];
			
			// would be cool to have this as a library, but as it stands,
			// there is no native lzma library for Node.js,
			// and subprocess piping just seems to be the fastest option
			var lzma = spawn('lzma', ['-6']); 
			lzma.stdout.on('data', function(data) { buflist.push(data); });
			lzma.stdout.on('end', function() { cont(Buffer.concat(buflist).toString('base64'), 'lzma'); });
			lzma.stdin.end(s);
		} : function(cont) {
			cont(s, 'raw');
		})(function(result, encoding) {
			cb({
				s: result,
				e: encoding,
				t: new Date().getTime()
			});
		});
	};
	
	d.on('response', function(data) {
		wrapForReply(data, function(r) { socket.emit('response', r) });
	});
	
	d.on('push', function(data) {
		wrapForReply(data, function(r) { socket.emit('push', r) });
	});
	
	d.on('error', function(data) {
		wrapForReply(data, function(r) { socket.emit('error', r) });
	});
	
	socket.on('query', eh.wrap(function(query) {
		recentQueries.push([query, d.toString()]);
		while (recentQueries.length > recentQueryCount)
			recentQueries.shift();
		
		d.query(query);
	}));
	
	socket.on('disconnect', eh.wrap(function() {
		d.disconnected();
	}));
});

}, this));
})();
