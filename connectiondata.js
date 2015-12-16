(function () { "use strict";

var _ = require('lodash');
var lzma = require('lzma-native');
var util = require('util');
var assert = require('assert');
var Q = require('q');
var commonUtil = require('tradity-connection');
var debug = require('debug')('sotrade:conn');
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
 * @property {int} queryCompressionInfo  Statistical information on compression availability
 *                                       and usage
 * @property {object} versionInfo.minimum  Minimum client API version supported
 * @property {object} versionInfo.current  Most recent API version
 * 
 * @public
 * @constructor module:connectiondata~ConnectionData
 * @augments module:stbuscomponent~STBusComponent
 */
class ConnectionData extends buscomponent.BusComponent {
	constructor(socket) {
		super();
		
		var now = Date.now();
		
		this.ctx = new qctx.QContext();
		this.hsheaders = _.omit(socket.handshake.headers, ['authorization', 'proxy-authorization']);
		this.remoteip = this.hsheaders['x-forwarded-for'] || this.hsheaders['x-real-ip'] || '127.0.0.182';
		this.cdid = now + '-' + this.remoteip + '-' + commonUtil.locallyUnique();
		this.connectTime = now;
		this.pushEventsTimer = null;
		this.lastInfoPush = 0;
		this.currentInfoPush = null;
		this.currentFetchingEvents = null;
		this.mostRecentEventTime = null;
		this.socket = socket;
		this.isShuttingDown = false;
		this.unansweredCount = 0;
		
		this.ctx.addProperty({name: 'lastSessionUpdate', value: null});
		this.ctx.addProperty({name: 'pendingTicks', value: 0});
		this.ctx.addProperty({name: 'remoteProtocolVersion', value: null});
		this.ctx.addProperty({name: 'remoteClientSoftware', value: null});
		this.ctx.addProperty({name: 'compressionSupport', value: {}});
		this.ctx.addProperty({name: 'isBusTransport', value: false});
		this.ctx.debugHandlers.push(_.bind(this.dbgHandler, this));
		this.ctx.errorHandlers.push(_.bind(this.ISEHandler, this));
		
		this.queryCount = 0;
		this.queryCompressionInfo = {
			supported: {lzma: 0, s:0},
			used: {lzma: 0, s:0, si:0}
		};
		
		this.versionInfo = {
			minimum: 1,
			current: 1
		};
		
		this.query_ = _.bind(this.queryHandler, this);
		this.disconnected_ = _.bind(this.disconnectedHandler, this);
		
		socket.on('error', _.bind(this.emitError, this));
		socket.on('query', this.query_);
		socket.on('disconnect', this.disconnected_);
		
		debug('Set up new connection', this.cdid);
	}
}

ConnectionData.prototype.onBusConnect = function() {
	var self = this;
	return self.ctx.setBusFromParent(self).then(function() {
		return self.getServerConfig();
	}).then(function(cfg) {
		var clientconfig = _.pick(cfg, cfg.clientconfig);
		clientconfig.busid = self.bus.id;
		clientconfig.pid = process.pid;
		
		return self.push({type: 'server-config', 'config': clientconfig, 'versionInfo': self.versionInfo});
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
		queryCompressionInfo: this.queryCompressionInfo,
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
ConnectionData.loginIgnore = [
	'list-schools', 'password-reset', 'register', 'emailverif', 'login', 'prod',
	'ping', 'school-exists', 'process-wordpress-feed', 'get-invitekey-info',
	'validate-username', 'validate-email', 'list-genders', 'list-questionnaires'
];

/**
 * Load all events that have not yet been sent to the client and send them.
 * 
 * @param {object} query  A query object that will be passed to {@link busreq~feedFetchEvents}
 * 
 * @function module:connectiondata~ConnectionData#fetchEvents
 */
ConnectionData.prototype.fetchEvents = function(query) {
	var self = this;
	
	if (!self.ctx.user)
		return; // no user – no user events.
	
	if (query.since)
		self.mostRecentEventTime = Math.max(self.mostRecentEventTime, parseInt(query.since));
	
	// possibly push info 
	self.pushSelfInfo();
	
	if (self.currentFetchingEvents)
		return self.currentFetchingEvents;
	
	// fetch regular events
	return self.currentFetchingEvents = self.request({
		name: 'feedFetchEvents',
		query: query,
		ctx: self.ctx.clone()
	}).then(function(evlist) {
		self.currentFetchingEvents = null;
		
		if (evlist.length == 0)
			return;
		
		_.each(evlist, function(ev) {
			self.mostRecentEventTime = Math.max(self.mostRecentEventTime, ev.eventtime);
		});

		return self.wrapForReply({pushes: evlist}).then(function(r) {
			debug('Writing push container', self.cdid);
		
			if (self.socket)
				return self.socket.emit('push-container', r);
		}).catch(function(e) {
			return self.emitError(e);
		});
	});
};

/**
 * Informs the client that there has been a server error.
 * 
 * @function module:connectiondata~ConnectionData#ISEHandler
 */
ConnectionData.prototype.ISEHandler = function() {
	return this.push({type: 'internal-server-error'});
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
	return this.push({type: 'debug-info', args: args});
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
	var self = this;
	
	debug('Push event', self.cdid, data.type);
	
	return self.wrapForReply(data).then(function(r) {
		debug('Writing single push', self.cdid, data.type);
			
		if (self.socket)
			self.socket.emit('push', r);
	}).then(function() {
		return self.pushSelfInfo();
	}).catch(function(e) {
		return self.emitError(e);
	});
};

/**
 * Pushes a <code>self-info</code> event to the client
 * (if the last such push wasn’t <em>too</em> recently).
 * 
 * @function module:connectiondata~ConnectionData#pushSelfInfo
 */
ConnectionData.prototype.pushSelfInfo = function() {
	var self = this;
	
	if (!self.ctx.user || !self.socket)
		return;
	
	assert.ok(self.bus);
	
	return self.getServerConfig().then(function(cfg) {
		var curUnixTime = Date.now();
		if (curUnixTime > self.lastInfoPush + cfg.infopushMinDelta) {
			self.lastInfoPush = curUnixTime;
			
			if (self.currentInfoPush)
				return self.currentInfoPush;
			
			debug('Push self info', self.cdid);
			return self.currentInfoPush = self.request({
				name: 'client-get-user-info',
				query: {
					lookfor: '$self',
					nohistory: true
				},
				ctx: self.ctx.clone(),
				xdata: self.pickXDataFields()
			}).then(function(result) {
				assert.ok(result.code == 'get-user-info-success');
				assert.ok(result.result);
				
				result.result.type = 'self-info';
				self.currentInfoPush = null;
				
				return self.push(result.result);
			});
		}
	});
};

/**
 * Fetch and push, within the next second, all game events for the current user.
 * 
 * @function module:connectiondata~ConnectionData#pushEvents
 */
ConnectionData.prototype.pushEvents = buscomponent.listener('push-events', function() {
	var self = this;
	
	debug('Push pending events', self.cdid, !!self.pushEventsTimer, self.ctx.user && self.ctx.user.uid);
	
	if (self.pushEventsTimer)
		return self.pushEventsTimer;
	
	if (!self.ctx.user || !self.ctx.user.uid)
		return;
	
	self.pushEventsTimer = Q.delay(1000).then(function() {
		self.pushEventsTimer = null;
		
		if (self.socket === null)
			return;
		
		return self.fetchEvents({
			since: self.mostRecentEventTime === null ? Date.now() / 1000 - 10 : self.mostRecentEventTime,
			count: null
		});
	});
	
	return self.pushEventsTimer;
});

/**
 * Format and push a response to a client request.
 * 
 * @function module:connectiondata~ConnectionData#response
 */
ConnectionData.prototype.response = function(data) {
	var self = this;
	
	var res = self.wrapForReply(data).then(function(r) {
		if (!self.socket)
			debug('Lost socket while compiling response', self.cdid);
		
		debug('Writing response', self.cdid);
		
		if (self.socket)
			self.socket.emit('response', r);
	}).catch(function(e) {
		return self.emitError(e);
	});
	
	if (self.isShuttingDown)
		self.shutdown();
	
	return res;
};

/**
 * Callback which will be invoked when a user just logged in or connected.
 * 
 * @function module:connectiondata~ConnectionData#onUserConnected
 */
ConnectionData.prototype.onUserConnected = function() {
	return this.request({name: 'checkAchievements', ctx: this.ctx.clone()});
};

/**
 * Callback which will be invoked when a user just logged out or disconnected.
 * 
 * @function module:connectiondata~ConnectionData#onUserConnected
 */
ConnectionData.prototype.onLogout = function() {
	var self = this;
	
	debug('Logout handler invoked', self.cdid, self.ctx.user && self.ctx.user.uid);
	
	return self.request({name: 'updateUserStatistics', ctx: self.ctx.clone(), user: self.ctx.user, force: true}).then(function() {
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
 * @param {?object} query.csupp  Compression support information.
 * @param {boolean} query.csupp.lzma  The response may be encoded using LZMA compression
 * @param {boolean} query.csupp.s  The response may be encoded using split compression
 * @param {int} query.pv  The current remote protocol version.
 * @param {string} query.cs  A version string describing the client software.
 * @param {string} query.type  A string describing what kind of requests is to be handled.
 *                             The various kinds of types are documented in the
 *                             {@link c2s} namespace.
 * 
 * @function module:connectiondata~ConnectionData#queryHandler
 */
ConnectionData.prototype.queryHandler = function(query) {
	var self = this;
	
	if (!query)
		return;
	
	return Q().then(function() {
		if (!query.signedContent)
			return {query: query, masterAuthorization: false};
		
		return self.request({
			name: 'verifySignedMessage',
			ctx: self.ctx.clone(),
			msg: query.signedContent,
			maxAge: 900
		}).then(function(verified) {
			if (verified)
				return {query: verified, masterAuthorization: true};
			else
				return {query: null, masterAuthorization: false};
		});
	}).then(function(queryInfo) {
		var masterAuthorization = queryInfo.masterAuthorization;
		var query = queryInfo.query;
		
		if (!query)
			return;
		
		debug('Received query of type', self.cdid, query.type, query.id);
		var recvTime = Date.now();
		
		self.queryCount++;
		if (query.lzma && !query.csupp)
			query.csupp = {lzma: 1};
		
		if (query.csupp)
			self.ctx.setProperty('compressionSupport', query.csupp);
		
		query.csupp = query.csupp || {};
		
		for (var i in query.csupp)
			self.queryCompressionInfo.supported[i] += 1;
		
		self.ctx.setProperty('remoteProtocolVersion', 
			(query.pv ? parseInt(query.pv) ||
			self.ctx.getProperty('remoteProtocolVersion') : 1));
		self.ctx.setProperty('remoteClientSoftware', 
			(query.cs ? String(query.cs) ||
			self.ctx.getProperty('remoteClientSoftware') : 'NULL0'));
		
		var hadUser = !!self.ctx.user;
		
		assert.ok(self.bus);
		assert.ok(self.socket);
		
		return self.request({name: 'loadSessionUser', key: String(query.key), ctx: self.ctx}).then(function(user) {
			debug('Session loading returned user', self.cdid, user && user.uid);
			if (!self.bus) {
				assert.ok(!self.socket);
				return;
			}
			
			var access = new Access();
			if (user != null) 
				access.update(Access.fromJSON(user.access));
			
			self.ctx.access.update(access);
			
			if (masterAuthorization) {
				self.ctx.access.grantAny();
				if (user == null && query.uid != null)
					user = {uid: query.uid};
			}
			
			self.ctx.user = user;
			self.ctx.access[['grant', 'drop'][self.ctx.user && self.ctx.user.email_verif ? 0 : 1]]('email_verif');
			
			if (!hadUser && self.ctx.user != null)
				self.onUserConnected();
			
			var callbackHasBeenCalled = false;
			
			return Q().then(function() {
				self.unansweredCount++;
				if (self.isShuttingDown)
					throw new self.SoTradeClientError('server-shutting-down');
				
				if (ConnectionData.loginIgnore.indexOf(query.type) == -1 &&
					self.ctx.user === null &&
					!self.ctx.access.has('login_override'))
				{
					throw new self.SoTradeClientError('not-logged-in');
				}
			
				switch (query.type) {
				/**
				 * Fetch all events not yet pushed to the client.
				 * See {@link module:connectiondata~ConnectionData#fetchEvents}
				 * for the query structure.
				 * 
				 * @return {object} Returns with <code>fetching-events</code>.
				 * 
				 * @function c2s~fetch-events
				 */
				case 'fetch-events':
					self.fetchEvents(query).done();
					return { code: 'fetching-events' };
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
						throw new self.PermissionDenied();
					
					debug('Setting up bus transport', self.cdid);
					self.ctx.setProperty('isBusTransport', true);
					self.bus.addTransport(new dt.DirectTransport(self.socket, query.weight || 10, false));
					return { code: 'init-bus-transport-success' };
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
						throw new self.PermissionDenied();
					self.ctx.setProperty('debugEnabled', query.debugMode);
					return { code: 'set-debug-mode-success' };
				// documented in user.js
				case 'logout':
					self.onLogout();
					// fall-through
				}
				
				return Q().then(function() {
					return self.request({
						name: 'client-' + query.type,
						query: query,
						ctx: self.ctx.clone(),
						xdata: self.pickXDataFields()
					});
				}).catch(function(e) {
					if (e.nonexistentType) {
						throw new self.SoTradeClientError('unknown-query-type');
					} else {
						self.emitError(e);
						throw new self.SoTradeClientError('internal-server-error');
					}
				});
			}).catch(function (e) {
				return e.toJSON();
			}).then(function(result) {
				assert.ok(result);
				assert.ok(result.code);
				
				debug('Query returned', self.cdid, query.type, query.id, result.code);
				
				if (callbackHasBeenCalled)
					return self.emitError(new Error('Callback for client request called multiple times!'));
				
				callbackHasBeenCalled = true;
				
				self.unansweredCount--;
				
				var now = Date.now();
				result['is-reply-to'] = query.id;
				result['_t_sdone'] = now;
				result['_t_srecv'] = recvTime;
				
				var extra = result.extra;
				delete result.extra;
				
				var finalizingPromises = [];
				if (extra == 'repush' && self.bus && self.socket) {
					self.lastInfoPush = 0;
					
					finalizingPromises.push(self.request({name: 'loadSessionUser', key: String(query.key), ctx: self.ctx.clone()})
						.then(function(newUser) {
						if (newUser)
							self.ctx.user = newUser;
						
						return self.pushSelfInfo();
					}));
				}
				
				finalizingPromises.push(self.response(result));
				
				return Q.all(finalizingPromises);
			});
		});
	}).catch(function(e) {
		return self.emitError(e);
	}).done();
};

/**
 * Callback which will be invoked when the socket.io instance disconnected.
 * 
 * @function module:connectiondata~ConnectionData#disconnectedHandler
 */
ConnectionData.prototype.disconnectedHandler = function() {
	debug('Disconnected', this.cdid);
	
	this.onLogout();
	
	if (this.socket) {
		this.socket.removeListener('query', this.query_);
		this.socket.removeListener('disconnect', this.disconnected_);
	}
	
	if (this.bus) {
		return this.request({name: 'deleteConnectionData', id: this.cdid}).then(function() {
			this.unplugBus();
			this.socket = null;
		});
	} else {
		// make sure we don't have a bus because we don't *want* one
		assert.ok(this.wantsUnplug);
	}
};

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
 * 
 * @return {object}  A Q promise for the encoded object.
 * 
 * @function module:connectiondata~ConnectionData#wrapForReply
 */
ConnectionData.prototype.wrapForReply = function(obj) {
	var self = this;
	
	return Q().then(function() {
		if (!self.socket) {
			self.ctx.setProperty('compressionSupport', {});
			self.ctx.setProperty('remoteProtocolVersion', null);
			self.ctx.setProperty('remoteClientSoftware', null);
		}
		
		var compressionThreshold = 20480;
		var splitCompressable = null;
		var csupp = self.ctx.getProperty('compressionSupport');
		
		var stringify = function(o) {
			try {
				return JSON.stringify(o, function(key, value) {
					// since Node v0.12, JSON.stringify does not convert
					// Buffers to integer arrays anymore
					if (Buffer.isBuffer(value))
						return Array.prototype.slice.call(value);
					if (value && value.type == 'Buffer' && value.data)
						return value.data;
					return value;
				});
			} catch (e) {
				// Most likely, obj was a circular data structure, so include that in the debug information
				if (e.type == 'circular_structure')
					throw new Error('Circular JSON while wrapping for reply, cycle: ' + commonUtil.detectCycle(o));
				else
					throw e;
			}
		}
		
		var compressable, noncompressable = '';
		var cc = null;
		
		if (csupp.s && obj.cc__) {
			cc = obj.cc__;
			delete obj.cc__;
			
			compressable    = _.pick(obj, cc.fields);
			noncompressable = _.omit(obj, cc.fields);
		} else {
			compressable = obj;
		}
		
		delete obj.cc__;
		
		var s  = stringify(compressable);
		var sn = stringify(noncompressable);
		
		if (csupp.s && csupp.lzma && noncompressable) {
			self.queryCompressionInfo.used.s += 1;
			self.queryCompressionInfo.used.lzma += 1;
			
			var ckey = cc.key + ':compressed';
			return Q().then(function() {
				if (cc.cache.has(ckey))
					return cc.cache.use(ckey);
				
				self.queryCompressionInfo.used.si += 1;
				return cc.cache.add(ckey, cc.validity, lzma.LZMA().compress(s, 3));
			}).then(function(result) {
				assert.ok(Buffer.isBuffer(result));
				
				debug('Use split LZMA compression', s.length + ' uncompressed', result.length + ' compressed', sn.length + ' other');
				
				return {
					e: 'split',
					s: [
						{ e: 'lzma', s: result },
						{ e: 'raw', s: sn }
					]
				};
			});
		} else if (csupp.lzma && s.length > compressionThreshold) {
			self.queryCompressionInfo.used.lzma += 1;
			
			return lzma.LZMA().compress(s, 3).then(function(result) {
				debug('Use LZMA compression', s.length + ' uncompressed', result.length + ' compressed');
				
				return { s: result, e: 'lzma' };
			});
		} else {
			debug('Do not use compression', s.length + ' uncompressed');
			
			return { s: s, e: 'raw' }; // e for encoding
		}
	}).then(function(wrappedObject) {
		wrappedObject.t = Date.now();
		
		return wrappedObject;
	});
};

exports.ConnectionData = ConnectionData;

})();
