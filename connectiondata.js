(function () { "use strict";

var _ = require('lodash');
var lzma = require('lzma-native');
var util = require('util');
var assert = require('assert');
var commonUtil = require('./common/util.js');
var buscomponent = require('./stbuscomponent.js');
var dt = require('./bus/directtransport.js');
var qctx = require('./qctx.js');
var Access = require('./access.js').Access;

/**
 * Main entry point for all game-relevant
 * <code>client &lt;-&gt; server<code> communication
 * 
 * @public
 * @module connectiondata
 */

/**
 * Represents and handles a single client connection.
 * 
 * @property {module:qctx~QContext} ctx  A QContext for all actions issued by this connection
 * @property {object} hsheaders  The HTTP headers of the socket connection handshake
 * @property {string} remoteip  A best guess for the remote ip
 * @property {string} cdid  An unique ID for this connection
 * @property pushEventsTimer  A setTimeout() timer for pushing events to the user
 * @property {int} lastInfoPush  Timestamp of the last <code>self-info</code> push
 *                               (Other than most timestamps in this software, this is in ms!)
 * @property {int} connectTime  Timestamp of connection establishment. (Also in ms!).
 * @property {int} mostRecentEventTime  The time of the most recent game event transmitted
 *                                      via this connection.
 * @property {socket} socket  The underlying socket.io instance
 * @property {boolean} isShuttingDown  Indicates whether new requests should be blocked due 
 *                                     to server shutdown
 * @property {int} unansweredCount  Number of received requests which were passed on to the local
 *                                  bus but were not answered yet.
 * @property {int} queryCount  Total number of queries received
 * @property {int} queryLZMACount  Number of queries received with LZMA support indicated
 * @property {int} queryLZMAUsedCount  Number of queries where LZMA was used for the response
 * @property {object} versionInfo.minimum  Minimum client API version supported
 * @property {object} versionInfo.current  Most recent API version
 * 
 * @public
 * @constructor module:connectiondata~ConnectionData
 * @augments module:stbuscomponent~STBusComponent
 */
function ConnectionData(socket) {
	ConnectionData.super_.apply(this, arguments);
	
	var now = Date.now();
	
	this.ctx = new qctx.QContext();
	this.hsheaders = _.omit(socket.handshake.headers, ['authorization', 'proxy-authorization']);
	this.remoteip = this.hsheaders['x-forwarded-for'] || this.hsheaders['x-real-ip'] || '127.0.0.182';
	this.cdid = now + '-' + this.remoteip + '-' + commonUtil.locallyUnique();
	this.connectTime = now;
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
	this.ctx.addProperty({name: 'isBusTransport', value: false});
	this.ctx.debugHandlers.push(_.bind(this.dbgHandler, this));
	this.ctx.errorHandlers.push(_.bind(this.ISEHandler, this));
	
	this.queryCount = 0;
	this.queryLZMACount = 0;
	this.queryLZMAUsedCount = 0;
	
	this.versionInfo = {
		minimum: 1,
		current: 1
	};
	
	this.query_ = _.bind(this.queryHandler, this);
	this.disconnected_ = _.bind(this.disconnectedHandler, this);
	
	socket.on('error', _.bind(this.emitError, this));
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

/**
 * Return a (serializable) object with general information on this connection.
 * A lot of attributes are taken verbatim from <code>this</code>, for further 
 * information see the source.
 * 
 * @function module:connectiondata~ConnectionData#stats
 */
ConnectionData.prototype.stats = function() {
	return {
		ctx: this.ctx.getStatistics(false),
		user: this.ctx.user ? { name: this.ctx.user.name, uid: this.ctx.user.uid } : null,
		lastInfoPush: this.lastInfoPush,
		mostRecentEventTime: this.mostRecentEventTime,
		queryCount: this.queryCount,
		queryLZMACount: this.queryLZMACount,
		queryLZMAUsedCount: this.queryLZMAUsedCount,
		ip: this.remoteip,
		xff: this.hsheaders['x-forwarded-for'],
		xrip: this.hsheaders['x-real-ip'],
		connectTime: this.connectTime,
		unanswered: this.unansweredCount,
		readonly: this.ctx.getProperty('readonly')
	};
};

/**
 * Return a simplified representation of this connection which
 * gets passed as <code>xdata</code> with client requests to the bus.
 * 
 * @function module:connectiondata~ConnectionData#pickXDataFields
 */
ConnectionData.prototype.pickXDataFields = function() {
	return _.pick(this, 'remoteip', 'hsheaders', 'cdid', 'lastInfoPush', 'mostRecentEventTime', 'connectTime');
};

ConnectionData.prototype.toString = function() {
	return JSON.stringify(this.pickXDataFields());
};

/**
 * A list of client requests types that can be called without active sessions.
 * 
 * @type {string[]}
 * 
 * @property module:connectiondata~ConnectionData.loginIgnore
 */
ConnectionData.loginIgnore = ['list-schools', 'password-reset', 'register', 'emailverif', 'login', 'prod', 'ping', 'school-exists', 'get-invitekey-info'];

/**
 * Load all events that have not yet been sent to the client and send them.
 * 
 * @param {object} query  A query object that will be passed to {@link busreq~feedFetchEvents}
 * 
 * @function module:connectiondata~ConnectionData#fetchEvents
 */
ConnectionData.prototype.fetchEvents = function(query) {
	if (!this.ctx.user)
		return; // no user – no events.
	
	// possibly push info 
	this.pushSelfInfo();
	
	// fetch regular events
	this.request({name: 'feedFetchEvents', query: query, ctx: this.ctx.clone()}, _.bind(function(evlist) {
		_.each(evlist, _.bind(function(ev) {
			this.mostRecentEventTime = Math.max(this.mostRecentEventTime, ev.eventtime);
		}, this));

		this.wrapForReply({pushes: evlist}, function(r) {
			if (this.socket)
				this.socket.emit('push-container', r)
		});
	}, this));
};

/**
 * Informs the client that there has been a server error.
 * 
 * @function module:connectiondata~ConnectionData#ISEHandler
 */
ConnectionData.prototype.ISEHandler = function() {
	this.push({type: 'internal-server-error'});
};

/**
 * Pushes debug information to the client.
 * 
 * @param args  An object to be pushed. This could, for example,
 *              be an array of arguments with the semantics of
 *              console.log parameters.
 * 
 * @function module:connectiondata~ConnectionData#dbgHandler
 */
ConnectionData.prototype.dbgHandler = function(args) {
	this.push({type: 'debug-info', args: args});
};

/**
 * Pushes a generic event to the client.
 * Also calls {@link module:connectiondata~ConnectionData#pushSelfInfo}.
 * 
 * @param {object} data  Any object describing an event.
 * @param {string} data.type  A string describing the kind of event to be pushed.
 *                            See also {@link Event} and {@link s2c}.
 * 
 * @function module:connectiondata~ConnectionData#push
 */
ConnectionData.prototype.push = function(data) {
	this.wrapForReply(data, function(r) {
		if (this.socket)
			this.socket.emit('push', r);
	});
	
	this.pushSelfInfo();
};

/**
 * Pushes a <code>self-info</code> event to the client
 * (if the last such push wasn’t <em>too</em> recently).
 * 
 * @function module:connectiondata~ConnectionData#pushSelfInfo
 */
ConnectionData.prototype.pushSelfInfo = function() {
	if (!this.ctx.user || !this.socket)
		return;
	
	assert.ok(this.bus);
	
	this.getServerConfig(function(cfg) {
		var curUnixTime = Date.now();
		if (curUnixTime > this.lastInfoPush + cfg.infopushMinDelta) {
			this.lastInfoPush = curUnixTime;
			this.request({
				name: 'client-get-user-info',
				query: {
					lookfor: '$self',
					nohistory: true
				},
				ctx: this.ctx.clone(),
				xdata: this.pickXDataFields()
			}, _.bind(function(code, info) {
				assert.ok(code == 'get-user-info-success');
				assert.ok(info);
				
				info.type = 'self-info';
				this.push(info);
			}, this));
		}
	});
};

/**
 * Fetch and push, within the next second, all game events for the current user.
 * 
 * @function module:connectiondata~ConnectionData#pushEvents
 */
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

/**
 * Format and push a response to a client request.
 * 
 * @function module:connectiondata~ConnectionData#response
 */
ConnectionData.prototype.response = function(data) {
	this.wrapForReply(data, function(r) {
		if (this.socket)
			this.socket.emit('response', r) 
	});
	
	if (this.isShuttingDown)
		this.shutdown();
};

/**
 * Callback which will be invoked when a user just logged in or connected.
 * 
 * @function module:connectiondata~ConnectionData#onUserConnected
 */
ConnectionData.prototype.onUserConnected = function() {
	this.request({name: 'checkAchievements', ctx: this.ctx.clone()});
};

/**
 * Callback which will be invoked when a user just logged out or disconnected.
 * 
 * @function module:connectiondata~ConnectionData#onUserConnected
 */
ConnectionData.prototype.onLogout = function() {
	var self = this;
	
	self.request({name: 'updateUserStatistics', ctx: self.ctx.clone(), user: self.ctx.user, force: true}, function() {
		self.ctx.user = null;
		self.ctx.access = new Access();
		self.ctx.setProperty('lastSessionUpdate', null);
		self.ctx.setProperty('pendingTicks', 0);
	});
};

/**
 * Main entry point for all client requests.
 * 
 * @param {object} query  An query object, usually with a lot of properties
 *                        specific to the query type.
 * @param {string} query.signedContent  If set, expect a message correctly signed
 *                                      with an accepttable public key. Its content is
 *                                      then used as a query object instead.
 *                                      This is useful for server-to-server queries
 *                                      and testing admin queries.
 *                                      See {@link module:signedmsg}.
 * @param {boolean} query.lzma  If true, the response may be encoded using LZMA compression.
 * @param {int} query.pv  The current remote protocol version.
 * @param {string} query.type  A string describing what kind of requests is to be handled.
 *                             The various kinds of types are documented in the
 *                             {@link c2s} namespace.
 * 
 * @function module:connectiondata~ConnectionData#queryHandler
 */
ConnectionData.prototype.queryHandler = buscomponent.errorWrap(function(query) {
	var self = this;
	
	if (!query)
		return;
	
	(query.signedContent ? function(cont) {
		self.request({
			name: 'verifySignedMessage',
			ctx: self.ctx.clone(),
			msg: query.signedContent,
			maxAge: 900
		}, function(verified) {
			if (verified)
				cont(verified, true);
			else
				this.close();
		});
	} : function(cont) {
		cont(query, false);
	})(function(query, masterAuthorization) {
		if (!query)
			return;
		
		var recvTime = Date.now();
		
		self.queryCount++;
		if (query.lzma) {
			self.queryLZMACount++;
			self.ctx.setProperty('lzmaSupport', true);
		}
		
		self.ctx.setProperty('remoteProtocolVersion', 
			(query.pv ? parseInt(query.pv) ||
			self.ctx.getProperty('remoteProtocolVersion') : 1));
		
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
					
					self.request({name: 'loadSessionUser', key: String(query.key), ctx: self.ctx.clone()}, function(newUser) {
						if (newUser)
							self.ctx.user = newUser;
						
						self.pushSelfInfo();
					});
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
				/**
				 * Fetch all events not yet pushed to the client.
				 * See {@link module:connectiondata~ConnectionData#fetchEvents}
				 * for the query structure.
				 * 
				 * @return {object} Returns with <code>fetching events</code>.
				 * 
				 * @function c2s~fetch-events
				 */
				case 'fetch-events':
					self.fetchEvents(query);
					return cb('fetching-events');
				/**
				 * Sets up this connection as a bus (server-to-server) transport.
				 * This requires unlimited privileges.
				 * 
				 * @param {int} query.time  The client unix timestamp (in ms!).
				 * @param {?int} [query.weight=10]  A weight of this connection
				 *                                  (for shortest path finding).
				 * 
				 * @return {object} Returns with <code>init-bus-transport-success</code>
				 *                  or a common error code.
				 * 
				 * @function c2s~init-bus-transport
				 */
				case 'init-bus-transport':
					if (!masterAuthorization)
						return cb('permission-denied');
					
					self.ctx.setProperty('isBusTransport', true);
					self.bus.addTransport(new dt.DirectTransport(this.socket, query.weight || 10, false));
					return cb('init-bus-transport-success');
				/**
				 * Tell the current {@link module:qctx~QContext} to send back
				 * debugging information.
				 * 
				 * @return {object} Returns with <code>set-debug-mode-successtime</code> 
				 *                  or a common error code.
				 * 
				 * @function c2s~set-debug-mode
				 */
				case 'set-debug-mode':
					if (!self.ctx.access.has('server'))
						return cb('permission-denied');
					self.ctx.setProperty('debugEnabled', query.debugMode);
					return cb('set-debug-mode-success');
				// documented in user.js
				case 'logout':
					self.onLogout();
					// fall-through
				}
				
				try {
					self.request({
						name: 'client-' + query.type,
						query: query,
						ctx: self.ctx.clone(),
						xdata: self.pickXDataFields()
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

/**
 * Callback which will be invoked when the socket.io instance disconnected.
 * 
 * @function module:connectiondata~ConnectionData#disconnectedHandler
 */
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

/**
 * Close the current connection.
 * 
 * @function module:connectiondata~ConnectionData#close
 */
ConnectionData.prototype.close = function() {
	if (this.socket)
		this.socket.disconnect();
	else // disconnectedHandler would also be called via socket.disconnect()
		this.disconnectedHandler();
};

/**
 * Sets the shutting down flag and, if there are no unanswered requests,
 * closes the connection.
 * 
 * @function module:connectiondata~ConnectionData#close
 */
ConnectionData.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
	this.isShuttingDown = true;
	
	if (this.unansweredCount == 0)
		this.close();
});

/**
 * Wraps an object, possibly compressing it, for sending it to the client.
 * 
 * @param {object} obj  Any kind of object to be sent.
 * @param {function} cb  Will be called with the encoded object as the 1st parameter.
 * 
 * @function module:connectiondata~ConnectionData#wrapForReply
 */
ConnectionData.prototype.wrapForReply = function(obj, cb) {
	cb = _.bind(cb, this);
	
	var s;
	try {
		s = JSON.stringify(obj);
	} catch (e) {
		// Most likely, this was a circular data structure, so include that in the debug information
		if (e.type == 'circular_structure')
			return this.emitError(new Error('Circular JSON while wrapping for reply, cycle: ' + commonUtil.detectCycle(obj)));
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

})();
