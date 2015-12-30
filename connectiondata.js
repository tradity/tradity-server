(function () { "use strict";

var _ = require('lodash');
var lzma = require('lzma-native');
var util = require('util');
var assert = require('assert');
var commonUtil = require('tradity-connection');
var debug = require('debug')('sotrade:conn');
var buscomponent = require('./stbuscomponent.js');
var dt = require('./bus/directtransport.js');
var qctx = require('./qctx.js');
var Access = require('./access.js').Access;
const promiseUtil = require('./lib/promise-util.js');

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
    this.ctx.debugHandlers.push(args => this.dbgHandler(args));
    this.ctx.errorHandlers.push(err => this.ISEHandler(err));
    
    this.queryCount = 0;
    this.queryCompressionInfo = {
      supported: {lzma: 0, s:0},
      used: {lzma: 0, s:0, si:0}
    };
    
    this.versionInfo = {
      minimum: 1,
      current: 1
    };
    
    this.query_ = query => this.queryHandler(query);
    this.disconnected_ = () => this.disconnectedHandler();
    
    socket.on('error', e => this.emitError(e));
    socket.on('query', this.query_);
    socket.on('disconnect', this.disconnected_);
    
    debug('Set up new connection', this.cdid);
  }
}

ConnectionData.prototype.onBusConnect = function() {
  return this.ctx.setBusFromParent(this).then(() => {
    return this.getServerConfig();
  }).then(cfg => {
    var clientconfig = _.pick(cfg, cfg.clientconfig);
    clientconfig.busid = this.bus.id;
    clientconfig.pid = process.pid;
    
    return this.push({type: 'server-config', 'config': clientconfig, 'versionInfo': this.versionInfo});
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
  if (!this.ctx.user)
    return; // no user – no user events.
  
  if (query.since)
    this.mostRecentEventTime = Math.max(this.mostRecentEventTime, parseInt(query.since));
  
  // possibly push info
  this.pushSelfInfo();
  
  if (this.currentFetchingEvents)
    return this.currentFetchingEvents;
  
  // fetch regular events
  return this.currentFetchingEvents = this.request({
    name: 'feedFetchEvents',
    query: query,
    ctx: this.ctx.clone()
  }).then(evlist => {
    this.currentFetchingEvents = null;
    
    if (evlist.length == 0)
      return;
    
    evlist.forEach(ev => {
      this.mostRecentEventTime = Math.max(this.mostRecentEventTime, ev.eventtime);
    });

    return this.wrapForReply({pushes: evlist}).then(r => {
      debug('Writing push container', this.cdid);
    
      if (this.socket)
        return this.socket.emit('push-container', r);
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
  debug('Push event', this.cdid, data.type);
  
  return this.wrapForReply(data).then(r => {
    debug('Writing single push', this.cdid, data.type);
      
    if (this.socket)
      this.socket.emit('push', r);
  }).then(() => {
    return this.pushSelfInfo();
  }).catch(e => {
    return this.emitError(e);
  });
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
  
  return this.getServerConfig().then(cfg => {
    var curUnixTime = Date.now();
    if (curUnixTime > this.lastInfoPush + cfg.infopushMinDelta) {
      this.lastInfoPush = curUnixTime;
      
      if (this.currentInfoPush)
        return this.currentInfoPush;
      
      debug('Push self info', this.cdid);
      return this.currentInfoPush = this.request({
        name: 'client-get-user-info',
        query: {
          lookfor: '$self',
          nohistory: true
        },
        ctx: this.ctx.clone(),
        xdata: this.pickXDataFields()
      }).then(result => {
        assert.ok(result.code == 'get-user-info-success');
        assert.ok(result.result);
        
        result.result.type = 'self-info';
        this.currentInfoPush = null;
        
        return this.push(result.result);
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
  debug('Push pending events', this.cdid, this.bus && this.bus.id, !!this.pushEventsTimer, this.ctx.user && this.ctx.user.uid);
  
  if (this.pushEventsTimer)
    return this.pushEventsTimer;
  
  if (!this.ctx.user || !this.ctx.user.uid)
    return;
  
  return this.pushEventsTimer = promiseUtil.delay(1000).then(() => {
    this.pushEventsTimer = null;
    
    if (this.socket === null)
      return;
    
    return this.fetchEvents({
      since: this.mostRecentEventTime === null ? Date.now() / 1000 - 10 : this.mostRecentEventTime,
      count: null
    });
  });
});

/**
 * Format and push a response to a client request.
 * 
 * @function module:connectiondata~ConnectionData#response
 */
ConnectionData.prototype.response = function(data) {
  var res = this.wrapForReply(data).then(r => {
    if (!this.socket)
      debug('Lost socket while compiling response', this.cdid);
    
    debug('Writing response', this.cdid);
    
    if (this.socket)
      this.socket.emit('response', r);
  }).catch(e => this.emitError(e));
  
  if (this.isShuttingDown)
    this.shutdown();
  
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
 * @function module:connectiondata~ConnectionData#onLogout
 */
ConnectionData.prototype.onLogout = function() {
  debug('Logout handler invoked', this.cdid, this.ctx.user && this.ctx.user.uid);
  
  return this.request({name: 'updateUserStatistics', ctx: this.ctx.clone(), user: this.ctx.user, force: true}).then(() => {
    this.ctx.user = null;
    this.ctx.access = new Access();
    this.ctx.setProperty('lastSessionUpdate', null);
    this.ctx.setProperty('pendingTicks', 0);
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
  if (!query)
    return;
  
  return Promise.resolve().then(() => {
    if (!query.signedContent)
      return {query: query, masterAuthorization: false};
    
    return this.request({
      name: 'verifySignedMessage',
      ctx: this.ctx.clone(),
      msg: query.signedContent,
      maxAge: 900
    }).then(verified => {
      if (verified)
        return {query: verified, masterAuthorization: true};
      else
        return {query: null, masterAuthorization: false};
    });
  }).then(queryInfo => {
    var masterAuthorization = queryInfo.masterAuthorization;
    var query = queryInfo.query;
    
    if (!query)
      return;
    
    debug('Received query of type', this.cdid, this.bus && this.bus.id, query.type, query.id);
    var recvTime = Date.now();
    
    this.queryCount++;
    if (query.lzma && !query.csupp)
      query.csupp = {lzma: 1};
    
    if (query.csupp)
      this.ctx.setProperty('compressionSupport', query.csupp);
    
    query.csupp = query.csupp || {};
    
    for (var i in query.csupp)
      this.queryCompressionInfo.supported[i] += 1;
    
    this.ctx.setProperty('remoteProtocolVersion', 
      (query.pv ? parseInt(query.pv) ||
      this.ctx.getProperty('remoteProtocolVersion') : 1));
    this.ctx.setProperty('remoteClientSoftware', 
      (query.cs ? String(query.cs) ||
      this.ctx.getProperty('remoteClientSoftware') : 'NULL0'));
    
    var hadUser = !!this.ctx.user;
    
    assert.ok(this.bus);
    assert.ok(this.socket);
    
    return this.request({name: 'loadSessionUser', key: String(query.key), ctx: this.ctx}).then(user => {
      debug('Session loading returned user', this.cdid, user && user.uid);
      if (!this.bus) {
        assert.ok(!this.socket);
        return;
      }
      
      var access = new Access();
      if (user != null) 
        access.update(Access.fromJSON(user.access));
      
      this.ctx.access.update(access);
      
      if (masterAuthorization) {
        this.ctx.access.grantAny();
        if (user == null && query.uid != null)
          user = {uid: query.uid};
      }
      
      this.ctx.user = user;
      this.ctx.access[['grant', 'drop'][this.ctx.user && this.ctx.user.email_verif ? 0 : 1]]('email_verif');
      
      if (!hadUser && this.ctx.user != null)
        this.onUserConnected();
      
      return Promise.resolve().then(() => {
        this.unansweredCount++;
        if (this.isShuttingDown)
          throw new this.SoTradeClientError('server-shutting-down');
        
        if (ConnectionData.loginIgnore.indexOf(query.type) == -1 &&
          this.ctx.user === null &&
          !this.ctx.access.has('login_override'))
        {
          throw new this.SoTradeClientError('not-logged-in');
        }
      
        switch (query.type) {
        /**
         * Fetch all events not yet pushed to the client.
         * See {@link module:connectiondata~ConnectionData#fetchEvents}
         * for the query structure.
         * 
         * @return {object} Returns with <code>fetched-events</code>.
         * 
         * @function c2s~fetch-events
         */
        case 'fetch-events':
          return this.fetchEvents(query).then(() => ({ code: 'fetched-events' }));
        
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
            throw new this.PermissionDenied();
          
          debug('Setting up bus transport', this.cdid);
          this.ctx.setProperty('isBusTransport', true);
          return this.bus.addTransport(new dt.DirectTransport(this.socket, query.weight || 10, false))
            .then(() => ({ code: 'init-bus-transport-success' }));
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
          if (!this.ctx.access.has('server'))
            throw new this.PermissionDenied();
          this.ctx.setProperty('debugEnabled', query.debugMode);
          return { code: 'set-debug-mode-success' };
        // documented in user.js
        case 'logout':
          this.onLogout();
          // fall-through
        }
        
        return Promise.resolve().then(() => {
          return this.request({
            name: 'client-' + query.type,
            query: query,
            ctx: this.ctx.clone(),
            xdata: this.pickXDataFields()
          });
        }).catch(e => {
          debug('Query errored', this.cdid, query.type, query.id, e);
          if (e.isSotradeError)
            throw e;
          
          if (e.nonexistentType) {
            throw new this.SoTradeClientError('unknown-query-type');
          } else {
            this.emitError(e);
            throw new this.SoTradeClientError('internal-server-error');
          }
        });
      }).catch(e => {
        debug('Querry error catch', this.cdid, e);
        return e.toJSON();
      }).then(result => {
        debug('Query returned', this.cdid, query.type, query.id, result && result.code);
        
        assert.ok(result);
        assert.ok(result.code);
        
        this.unansweredCount--;
        
        var now = Date.now();
        result['is-reply-to'] = query.id;
        result['_t_sdone'] = now;
        result['_t_srecv'] = recvTime;
        
        var extra = result.extra;
        delete result.extra;
        
        var finalizingPromises = [];
        if (extra == 'repush' && this.bus && this.socket) {
          this.lastInfoPush = 0;
          
          finalizingPromises.push(this.request({name: 'loadSessionUser', key: String(query.key), ctx: this.ctx.clone()})
            .then(newUser => {
            if (newUser)
              this.ctx.user = newUser;
            
            return this.pushSelfInfo();
          }));
        }
        
        finalizingPromises.push(this.response(result));
        
        return Promise.all(finalizingPromises);
      });
    });
  }).catch(e => this.emitError(e));
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
    return this.request({name: 'deleteConnectionData', id: this.cdid}).then(() => {
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
 * @return {object}  A Promise for the encoded object.
 * 
 * @function module:connectiondata~ConnectionData#wrapForReply
 */
ConnectionData.prototype.wrapForReply = function(obj) {
  return Promise.resolve().then(() => {
    if (!this.socket) {
      this.ctx.setProperty('compressionSupport', {});
      this.ctx.setProperty('remoteProtocolVersion', null);
      this.ctx.setProperty('remoteClientSoftware', null);
    }
    
    var compressionThreshold = 20480;
    var splitCompressable = null;
    var csupp = this.ctx.getProperty('compressionSupport');
    
    var stringify = (o) => {
      try {
        return JSON.stringify(o, (key, value) => {
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
      this.queryCompressionInfo.used.s += 1;
      this.queryCompressionInfo.used.lzma += 1;
      
      var ckey = cc.key + ':compressed';
      return Promise.resolve().then(() => {
        if (cc.cache.has(ckey))
          return cc.cache.use(ckey);
        
        this.queryCompressionInfo.used.si += 1;
        return cc.cache.add(ckey, cc.validity, lzma.LZMA().compress(s, 3));
      }).then(result => {
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
      this.queryCompressionInfo.used.lzma += 1;
      
      return lzma.LZMA().compress(s, 3).then(result => {
        debug('Use LZMA compression', s.length + ' uncompressed', result.length + ' compressed');
        
        return { s: result, e: 'lzma' };
      });
    } else {
      debug('Do not use compression', s.length + ' uncompressed');
      
      return { s: s, e: 'raw' }; // e for encoding
    }
  }).then(wrappedObject => {
    wrappedObject.t = Date.now();
    
    return wrappedObject;
  });
};

exports.ConnectionData = ConnectionData;

})();
