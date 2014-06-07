(function () { "use strict";

var _ = require('underscore');
var lzma = require('lzma-native');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');
var Access = require('./access.js').Access;

function ConnectionData(socket) {
	this.lzmaSupport = false;
	this.user = null;
	this.hsheaders = _.omit(socket.handshake.headers, ['authorization', 'proxy-authorization']);
	this.remoteip = this.hsheaders['x-forwarded-for'] || this.hsheaders['x-real-ip'] || '127.0.0.182';
	this.cdid = new Date().getTime() + '-' + this.remoteip + '-' + ConnectionData.uniqueCount++;
	this.access = new Access();
	this.pushEventsTimer = null;
	this.lastInfoPush = 0;
	this.mostRecentEventTime = 0;
	this.socket = socket;
	this.isShuttingDown = false;
	this.unansweredCount = 0;
	this.pushesServerStatistics = false;
	
	this.queryCount = 0;
	this.queryLZMACount = 0;
	this.queryLZMAUsedCount = 0;
	
	this.query_ = _.bind(this.query, this);
	this.disconnected_ = _.bind(this.disconnected, this);
	
	socket.on('query', this.query_);
	socket.on('disconnect', this.disconnected_);
}
util.inherits(ConnectionData, buscomponent.BusComponent);

ConnectionData.prototype.onBusConnect = function() {
	this.getServerConfig(function(cfg) {
		this.push({type: 'server-config', 'config': _.pick(cfg, cfg.clientconfig)});
	});
};

ConnectionData.prototype.stats = function() {
	return {
		lzma: this.lzmaSupport,
		user: this.user ? { name: this.user.name, uid: this.user.uid } : null,
		lastInfoPush: this.lastInfoPush,
		mostRecentEventTime: this.mostRecentEventTime,
		queryCount: this.queryCount,
		queryLZMACount: this.queryLZMACount,
		queryLZMAUsedCount: this.queryLZMAUsedCount,
		ip: this.remoteip,
		xff: this.hsheaders['x-forwarded-for'],
		xrip: this.hsheaders['x-real-ip'],
		unanswered: this.unansweredCount
	};
};

ConnectionData.prototype.pickTextFields = function() {
	return _.pick(this, 'user', 'remoteip', 'hsheaders', 'cdid', 'access', 'lastInfoPush', 'mostRecentEventTime');
};

ConnectionData.prototype.toString = function() {
	return JSON.stringify(this.pickTextFields());
};

ConnectionData.uniqueCount = 0;

ConnectionData.loginIgnore = ['list-schools', 'password-reset', 'register', 'emailverif', 'login', 'prod', 'ping', 'school-exists', 'server-config'];

ConnectionData.prototype.fetchEvents = function(query) {
	if (!this.user)
		return; // no user – no events.
	
	// possibly push info 
	this.pushSelfInfo();
	
	// fetch regular events
	this.request({name: 'feedFetchEvents', query: query, user: this.user, access: this.access}, _.bind(function(evlist) {
		_.each(evlist, _.bind(function(ev) {
			this.mostRecentEventTime = Math.max(this.mostRecentEventTime, ev.eventtime);
		}, this));

		this.wrapForReply({pushes: evlist}, function(r) {
			if (this.socket)
				this.socket.emit('push-container', r)
		});
	}, this));
};

ConnectionData.prototype.pushServerStatistics = buscomponent.listener('pushServerStatistics', function(data) {
	if (this.pushesServerStatistics) {
		data.type = 'push-server-statistics';
		this.push(data);
	}
});

ConnectionData.prototype.push = function(data) {
	this.wrapForReply(data, function(r) {
		if (this.socket)
			this.socket.emit('push', r);
	});
	
	this.pushSelfInfo();
};

ConnectionData.prototype.pushSelfInfo = function() {
	if (!this.user || !this.socket)
		return;
	
	assert.ok(this.bus);
	
	this.getServerConfig(function(cfg) {
		var curUnixTime = new Date().getTime();
		if (curUnixTime > this.lastInfoPush + cfg['infopush-mindelta']) {
			this.lastInfoPush = curUnixTime;
			this.request({name: 'client-get-user-info', query: {lookfor: '$self', nohistory: true}, user: this.user, access: this.access, xdata: this.pickTextFields()}, _.bind(function(info) {
				if (!info) // wtf?
					return this.emit('error', new Error('no user on $self in info push handler'));
				info.type = 'self-info';
				this.push(info);
			}, this));
		}
	});
};

ConnectionData.prototype.pushEvents = buscomponent.listener('push-events', function() {
	if (this.pushEventsTimer || !this.user || !this.user.uid)
		return;
	
	this.pushEventsTimer = setTimeout(_.bind(function() {
		this.pushEventsTimer = null;
		
		if (this.socket === null)
			return;
		
		this.fetchEvents({since: this.mostRecentEventTime, count: null});
	}, this), 1000);
});

ConnectionData.prototype.response = function(data) {
	this.wrapForReply(data, function(r) {
		if (this.socket)
			this.socket.emit('response', r) 
	});
	
	if (this.isShuttingDown)
		this.shutdown();
};

ConnectionData.prototype.onUserConnected = function() {
	this.request({name: 'checkAchievements', user: this.user});
};

ConnectionData.prototype.query = buscomponent.errorWrap(function(query) {
	var recvTime = new Date().getTime();
	
	// sanitize by removing everything enclosed in '__'s
	var sanitizeQuery = function(q) {
		if (q.query)
			q.query = sanitizeQuery(q.query);
		
		return _.omit(q, _.chain(q).keys().filter(function(k) { return /^__.*__$/.test(k); }));
	};
	
	query = sanitizeQuery(query);
	
	this.queryCount++;
	if (query.lzma) {
		this.queryLZMACount++;
		this.lzmaSupport = true;
	}
	
	var hadUser = this.user ? true : false;
	
	assert.ok(this.bus);
	assert.ok(this.socket);
	
	this.request({name: 'loadSessionUser', key: query.key}, function(user) {
		if (!this.bus) {
			assert.ok(!this.socket);
			return;
		}
		
		this.request({name: 'getAuthorizationKey'}, function(authorizationKey) {
		
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
			this.unansweredCount--;
			
			var now = new Date().getTime();
			obj = obj || {};
			obj['code'] = code;
			obj['is-reply-to'] = query.id;
			obj['_t_sdone'] = now;
			obj['_t_srecv'] = recvTime;
			
			this.response(obj);
			
			if (extra == 'repush') {
				this.lastInfoPush = 0;
				
				this.request({name: 'loadSessionUser', key: query.key}, function(newUser) {
					if (newUser)
						this.user = newUser;
					
					this.pushSelfInfo();
				});
			} else if (extra == 'logout') {
				this.user = null;
				this.pushesServerStatistics = false;
				this.access = new Access();
			}
		}, this);
		
		this.unansweredCount++;
		if (this.isShuttingDown) {
			cb('server-shutting-down');
		} else if (ConnectionData.loginIgnore.indexOf(query.type) == -1 && this.user === null && !this.access.has('login_override')) {
			cb('not-logged-in');
		} else {
			switch (query.type) {
				case 'get-server-statistics':
					if (!this.access.has('userdb'))
						return cb('permission-denied');
					this.pushesServerStatistics = true;
					
					this.emit('getServerStatistics');
					
					var interval = setInterval(_.bind(function() {
						if (this.bus && this.socket && this.pushServerStatistics) {
							this.emit('getServerStatistics');
						} else {
							clearInterval(interval);
							interval = null;
						}
					}, this), 10000);
					
					return cb('get-server-statistics-success');
				case 'fetch-events':
					this.fetchEvents(query);
					return cb('fetching-events');
			}
			
			this.request({
				name: 'client-' + query.type,
				query: query,
				user: this.user,
				access: this.access,
				xdata: this.pickTextFields()
			}, cb);
		}
		
		});
	});
});

ConnectionData.prototype.disconnected = buscomponent.errorWrap(function() {
	if (this.socket) {
		this.socket.removeListener('query', this.query_);
		this.socket.removeListener('disconnect', this.disconnected_);
	}
	
	if (this.bus) {
		this.request({name: 'deleteConnectionData', id: this.cdid}, function() {
			this.unplugBus();
			this.socket = null;
		});
	} else {
		// make sure we don't have a bus because we don't *want* one
		assert.ok(this.wantsUnplug);
	}
});

ConnectionData.prototype.close = function() {
	if (this.socket)
		this.socket.disconnect();
	else // disconnected would also be called via socket.disconnect()
		this.disconnected();
};

ConnectionData.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
	this.isShuttingDown = true;
	
	if (this.unansweredCount == 0)
		this.close();
});

ConnectionData.prototype.wrapForReply = function(obj, cb) {
	cb = _.bind(cb, this);
	
	var s = JSON.stringify(obj);
	
	_.bind(s.length > 20480 && this.lzmaSupport ? function(cont) {
		this.queryLZMAUsedCount++;
		
		var buflist = [];
		
		var encoder = lzma.createStream('aloneEncoder', {preset: 3});
		encoder.on('data', function(data) { buflist.push(data); });
		encoder.on('end', function() { cont(Buffer.concat(buflist).toString('base64'), 'lzma'); });
		encoder.end(s);
	} : function(cont) {
		cont(s, 'raw');
	}, this)(function(result, encoding) {
		cb({
			s: result,
			e: encoding,
			t: new Date().getTime()
		});
	});
};

exports.ConnectionData = ConnectionData;

})();
