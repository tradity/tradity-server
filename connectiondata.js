(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var spawn = require('child_process').spawn;
var buscomponent = require('./buscomponent.js');
var Access = require('./access.js').Access;

function ConnectionData(socket) {
	this.lzmaSupport = false;
	this.user = null;
	this.remoteip = socket.handshake.address.address;
	this.hsheaders = _.omit(socket.handshake.headers, ['authorization', 'proxy-authorization']);
	this.cdid = new Date().getTime() + '-' + this.remoteip + '-' + ConnectionData.uniqueCount++;
	this.access = new Access();
	this.registeredEventHandlers = [];
	this.pushEventsTimer = null;
	this.lastInfoPush = 0;
	this.mostRecentEventTime = 0;
	this.socket = socket;
	
	this.query_ = _.bind(this.query, this);
	this.disconnected_ = _.bind(this.disconnected, this);
	
	socket.on('query', this.query_);
	socket.on('disconnect', this.disconnected_);
}
util.inherits(ConnectionData, buscomponent.BusComponent);

ConnectionData.prototype.onBusConnect = function() {
	this.regListenerBoundEx('push', this.push);
	this.regListenerBoundEx('push-events', this.pushEvents);
};

ConnectionData.prototype.toString = function() {
	return JSON.stringify(_.pick(this, 'user', 'remoteip', 'hsheaders', 'cdid', 'access', 'lastInfoPush', 'mostRecentEventTime'));
};

ConnectionData.uniqueCount = 0;

ConnectionData.loginIgnore = ['list-schools', 'password-reset', 'register', 'emailverif', 'login', 'prod', 'ping', 'get-config'];

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

		this.wrapForReply({pushes: evlist}, function(r) { this.socket.emit('push-container', r) });
	}, this));
};

ConnectionData.prototype.push = function(data) {
	if (data.type != 'stock-update')
		this.wrapForReply(data, function(r) { this.socket.emit('push', r); });
	
	this.pushSelfInfo();
};

ConnectionData.prototype.pushSelfInfo = function() {
	if (!this.user)
		return;
	
	this.getServerConfig(function(cfg) {
		
		var curUnixTime = new Date().getTime();
		if (curUnixTime > this.lastInfoPush + cfg['infopush-mindelta']) {
			this.lastInfoPush = curUnixTime;
			this.request({name: 'client-get-user-info', query: {lookfor: '$self', nohistory: true}, user: this.user, access: this.access, xdata: this}, _.bind(function(info) {
				if (!info) // wtf?
					return this.emit('error', new Error('no user on $self in info push handler'));
				info.type = 'self-info';
				this.push(info);
			}, this));
		}
	});
};

ConnectionData.prototype.pushEvents = function() {
	if (this.pushEventsTimer || !this.user || !this.user.uid)
		return;
	
	this.pushEventsTimer = setTimeout(_.bind(function() {
		if (this.socket === null)
			return;
		
		this.pushEventsTimer = null;
		this.fetchEvents({since: this.mostRecentEventTime, count: null});
	}, this), 1000);
};

ConnectionData.prototype.response = function(data) {
	this.wrapForReply(data, function(r) { this.socket.emit('response', r) });
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
	
	if (query.lzma)
		this.lzmaSupport = true;
	
	var hadUser = this.user ? true : false;
	
	this.request({name: 'loadSessionUser', key: query.key}, function(user) {
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
				this.access = new Access();
			}
		}, this);
		
		if (ConnectionData.loginIgnore.indexOf(query.type) == -1 && this.user === null && !this.access.has('login_override')) {
			cb('not-logged-in');
		} else {
			this.request({
				name: 'client-' + query.type,
				query: query,
				user: this.user,
				access: this.access,
				xdata: this,
				onDrop: function() { cb('unknown-query-type'); }
			}, cb);
		}
		
		});
	});
});

ConnectionData.prototype.regListenerBoundEx = function(event, fn) {
	var boundListener = _.bind(fn, this);
	this.registeredEventHandlers.push([event, boundListener]);
	this.on(event, boundListener, true); // set raw = true, so we can remove the listener later
};

ConnectionData.prototype.disconnected = buscomponent.errorWrap(function() {
	for (var i = 0; i < this.registeredEventHandlers.length; ++i) {
		var e = this.registeredEventHandlers[i];
		this.removeListener(e[0], e[1]);
	}
	
	this.socket.removeListener('query', this.query_);
	this.socket.removeListener('disconnect', this.disconnected_);
	
	this.request({name: 'deleteConnectionData', id: this.cdid}, function() {
		this.unplugBus();
		this.socket = null;
	});
});

ConnectionData.prototype.wrapForReply = function(obj, cb) {
	cb = _.bind(cb, this);
	
	var s = JSON.stringify(obj);
	
	(s.length > 20480 && this.lzmaSupport ? function(cont) {
		var buflist = [];
		
		// would be cool to have this as a library, but as it stands,
		// there is no native lzma library for Node.js,
		// and subprocess piping just seems to be the fastest option
		var lzma = spawn('lzma', ['-3']); 
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

exports.ConnectionData = ConnectionData;

})();
