(function () { "use strict";

var _ = require('underscore');
var lzma = require('lzma-native');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./bus/buscomponent.js');
var dt = require('./bus/directtransport.js');
var qctx = require('./qctx.js');
var Access = require('./access.js').Access;

function ConnectionData(socket) {
	this.ctx = new qctx.QContext();
	this.hsheaders = _.omit(socket.handshake.headers, ['authorization', 'proxy-authorization']);
	this.remoteip = this.hsheaders['x-forwarded-for'] || this.hsheaders['x-real-ip'] || '127.0.0.182';
	this.cdid = Date.now() + '-' + this.remoteip + '-' + ConnectionData.uniqueCount++;
	this.pushEventsTimer = null;
	this.lastInfoPush = 0;
	this.mostRecentEventTime = 0;
	this.socket = socket;
	this.isShuttingDown = false;
	this.unansweredCount = 0;
	
	this.ctx.addProperty({name: 'lastSessionUpdate', value: null});
	this.ctx.addProperty({name: 'pendingTicks', value: 0});
	this.ctx.addProperty({name: 'remoteProtocolVersion', value: null});
	this.ctx.addProperty({name: 'lzmaSupport', value: false});
	
	this.queryCount = 0;
	this.queryLZMACount = 0;
	this.queryLZMAUsedCount = 0;
	
	this.query_ = _.bind(this.queryHandler, this);
	this.disconnected_ = _.bind(this.disconnectedHandler, this);
	
	this.versionInfo = {
		minimum: 1,
		current: 1
	};
	
	socket.on('query', this.query_);
	socket.on('disconnect', this.disconnected_);
}
util.inherits(ConnectionData, buscomponent.BusComponent);

ConnectionData.prototype.onBusConnect = function() {
	this.ctx.setBusFromParent(this);
	
	this.getServerConfig(function(cfg) {
		this.push({type: 'server-config', 'config': _.pick(cfg, cfg.clientconfig), 'versionInfo': this.versionInfo});
	});
};

ConnectionData.prototype.stats = function() {
	return {
		lzma: this.ctx.getProperty('lzmaSupport'),
		remoteProtocolVersion: this.ctx.getProperty('remoteProtocolVersion'),
		user: this.ctx.user ? { name: this.ctx.user.name, uid: this.ctx.user.uid } : null,
		lastInfoPush: this.lastInfoPush,
		mostRecentEventTime: this.mostRecentEventTime,
		queryCount: this.queryCount,
		queryLZMACount: this.queryLZMACount,
		queryLZMAUsedCount: this.queryLZMAUsedCount,
		ip: this.remoteip,
		xff: this.hsheaders['x-forwarded-for'],
		xrip: this.hsheaders['x-real-ip'],
		unanswered: this.unansweredCount,
		readonly: this.ctx.getProperty('readonly')
	};
};

ConnectionData.prototype.pickTextFields = function() {
	return _.pick(this, 'ctx', 'remoteip', 'hsheaders', 'cdid', 'lastInfoPush', 'mostRecentEventTime');
};

ConnectionData.prototype.toString = function() {
	return JSON.stringify(this.pickTextFields());
};

ConnectionData.uniqueCount = 0;

ConnectionData.loginIgnore = ['list-schools', 'password-reset', 'register', 'emailverif', 'login', 'prod', 'ping', 'school-exists', 'server-config'];

ConnectionData.prototype.fetchEvents = function(query) {
	if (!this.ctx.user)
		return; // no user – no events.
	
	// possibly push info 
	this.pushSelfInfo();
	
	// fetch regular events
	this.request({name: 'feedFetchEvents', query: query, ctx: this.ctx}, _.bind(function(evlist) {
		_.each(evlist, _.bind(function(ev) {
			this.mostRecentEventTime = Math.max(this.mostRecentEventTime, ev.eventtime);
		}, this));

		this.wrapForReply({pushes: evlist}, function(r) {
			if (this.socket)
				this.socket.emit('push-container', r)
		});
	}, this));
};

ConnectionData.prototype.push = function(data) {
	this.wrapForReply(data, function(r) {
		if (this.socket)
			this.socket.emit('push', r);
	});
	
	this.pushSelfInfo();
};

ConnectionData.prototype.pushSelfInfo = function() {
	if (!this.ctx.user || !this.socket)
		return;
	
	assert.ok(this.bus);
	
	this.getServerConfig(function(cfg) {
		var curUnixTime = Date.now();
		if (curUnixTime > this.lastInfoPush + cfg['infopush-mindelta']) {
			this.lastInfoPush = curUnixTime;
			this.request({name: 'client-get-user-info', query: {lookfor: '$self', nohistory: true}, ctx: this.ctx, xdata: this.pickTextFields()}, _.bind(function(code, info) {
				assert.ok(code == 'get-user-info-success');
				assert.ok(info);
				
				info.type = 'self-info';
				this.push(info);
			}, this));
		}
	});
};

ConnectionData.prototype.pushEvents = buscomponent.listener('push-events', function() {
	if (this.pushEventsTimer || !this.ctx.user || !this.ctx.user.uid)
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
	this.request({name: 'checkAchievements', ctx: this.ctx});
};

ConnectionData.prototype.onLogout = function() {
	var self = this;
	
	self.request({name: 'updateUserStatistics', ctx: self.ctx, user: self.ctx.user, force: true}, function() {
		self.ctx.user = null;
		self.ctx.access = new Access();
		self.ctx.setProperty('lastSessionUpdate', null);
		self.ctx.setProperty('pendingTicks', 0);
	});
};

ConnectionData.prototype.queryHandler = buscomponent.errorWrap(function(query) {
	var self = this;
	
	(query.signedContent ? function(cont) {
		self.request({
			name: 'verifySignedMessage',
			msg: query.signedContent
		}, function(verified) {
			if (verified)
				cont(verified, true);
			else
				this.close();
		});
	} : function(cont) {
		cont(query, false);
	})(function(query, masterAuthorization) {
		var recvTime = Date.now();
		
		self.queryCount++;
		if (query.lzma) {
			self.queryLZMACount++;
			self.ctx.setProperty('lzmaSupport', true);
		}
		
		if (query.pv)
			self.ctx.setProperty('remoteProtocolVersion', parseInt(query.pv) ||
				self.ctx.getProperty('remoteProtocolVersion'));
		
		var hadUser = self.ctx.user ? true : false;
		
		assert.ok(self.bus);
		assert.ok(self.socket);
		
		self.request({name: 'loadSessionUser', key: String(query.key), ctx: self.ctx}, function(user) {
			if (!self.bus) {
				assert.ok(!self.socket);
				return;
			}
			
			var access = new Access();
			if (user != null) 
				access.update(Access.fromJSON(user.access));
			
			self.ctx.access.update(access);
			
			if (masterAuthorization) {
				console.log('Received query with master authorization of type', query.type);
				self.ctx.access.grantAny();
				if (user == null && query.uid != null)
					user = {uid: query.uid, id: query.uid};
			}
			
			self.ctx.user = user;
			self.ctx.access[['grant', 'drop'][self.ctx.user && self.ctx.user.email_verif ? 0 : 1]]('email_verif');
			
			if (!hadUser && self.ctx.user != null)
				self.onUserConnected();
			
			var cb = _.bind(function(code, obj, extra) {
				self.unansweredCount--;
				
				var now = Date.now();
				obj = obj || {};
				obj['code'] = code;
				obj['is-reply-to'] = query.id;
				obj['_t_sdone'] = now;
				obj['_t_srecv'] = recvTime;
				
				if (extra == 'repush' && self.bus && self.socket) {
					self.lastInfoPush = 0;
					
					self.request({name: 'loadSessionUser', key: String(query.key), ctx: self.ctx}, function(newUser) {
						if (newUser)
							self.ctx.user = newUser;
						
						self.pushSelfInfo();
					});
				} else if (extra == 'logout') {
					self.onLogout();
				}
				
				self.response(obj);
			}, self);
			
			self.unansweredCount++;
			if (self.isShuttingDown) {
				cb('server-shutting-down');
			} else if (ConnectionData.loginIgnore.indexOf(query.type) == -1 &&
				self.ctx.user === null &&
				!self.ctx.access.has('login_override'))
			{
				cb('not-logged-in');
			} else {
				switch (query.type) {
					case 'fetch-events':
						self.fetchEvents(query);
						return cb('fetching-events');
					case 'init-bus-transport':
						if (!masterAuthorization || query.time < Date.now() - 200000)
							return cb('permission-denied');
						
						self.bus.addTransport(new dt.DirectTransport(this.socket, query.weight || 10, false));
						return cb('init-bus-transport-success');
				}
				
				try {
					self.request({
						name: 'client-' + query.type,
						query: query,
						ctx: self.ctx,
						xdata: self.pickTextFields()
					}, cb);
				} catch (e) {
					if (e.nonexistentType) {
						cb('unknown-query-type');
					} else {
						cb('server-fail');
						self.emitError(e);
					}
				}
			}
		});
	});
});

ConnectionData.prototype.disconnectedHandler = buscomponent.errorWrap(function() {
	this.onLogout();
	
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
	else // disconnectedHandler would also be called via socket.disconnect()
		this.disconnectedHandler();
};

ConnectionData.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
	this.isShuttingDown = true;
	
	if (this.unansweredCount == 0)
		this.close();
});

ConnectionData.prototype.wrapForReply = function(obj, cb) {
	cb = _.bind(cb, this);
	
	var s;
	try {
		s = JSON.stringify(obj);
	} catch (e) {
		// Most likely, this was a circular data structure, so include that in the debug information
		if (e.type == 'circular_structure')
			return this.emitError(new Error('Circular JSON while wrapping for reply, cycle: ' + detectCycle(obj)));
		else
			return this.emitError(e);
	}
	
	if (!this.socket) {
		this.ctx.setProperty('lzmaSupport', false);
		this.ctx.setProperty('remoteProtocolVersion', null);
	}
	
	_.bind(s.length > 20480 && this.ctx.getProperty('lzmaSupport') ? function(cont) {
		this.queryLZMAUsedCount++;
		
		var buflist = [];
		
		var encoder = lzma.createStream('aloneEncoder', {preset: 3});
		encoder.on('data', function(data) { buflist.push(data); });
		encoder.on('end', function() { cont(Buffer.concat(buflist), 'lzma'); });
		encoder.end(s);
	} : function(cont) {
		cont(s, 'raw');
	}, this)(function(result, encoding) {
		cb({
			s: result,
			e: encoding,
			t: Date.now()
		});
	});
};

exports.ConnectionData = ConnectionData;

function detectCycle(o) {
	var seen = [];
	
	function dfs(o) {
		if (o && typeof o == 'object') {
			if (seen.indexOf(o) != -1)
				return true;
			
			seen.push(o);
			for (var key in o) {
				if (o.hasOwnProperty(key)) {
					var previousChain = dfs(o[key]);
					if (previousChain)
						return '.' + key + (previousChain === true ? '' : previousChain);
				}
			}
		}
		
		return false;
	}
	
	return dfs(o);
}

})();
