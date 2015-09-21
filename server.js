(function () { "use strict";

var _ = require('lodash');
var os = require('os');
var util = require('util');
var assert = require('assert');
var Q = require('q');
var http = require('http');
var https = require('https');
var url = require('url');
var sio = require('socket.io');
var debug = require('debug')('sotrade:server');
var busAdapter = require('./bus/socket.io-bus.js').busAdapter;
var buscomponent = require('./stbuscomponent.js');
var qctx = require('./qctx.js');
var ConnectionData = require('./connectiondata.js').ConnectionData;

/**
 * Provides the HTTP backend for all client connections
 * 
 * @public
 * @module server
 */

/**
 * Controller for socket clients
 * 
 * @property {object} httpServer  The associated node.js HTTP(S) server
 * @property {object} io  The socket.io instance listening for incoming sockets
 * @property {module:connectiondata~ConnectionData[]} clients  Full list of currently
 *                                                             active clients
 * @property {boolean} isShuttingDown  Indicates whether the serve is in shut-down mode
 * @property {int} creationTime  Unix timestamp of the object creation
 * @property {int} deadQueryCount  Total number of queries of disconnected clients
 * @property {int} deadQueryCompressionInfo  Statistical compression support information 
 *                                           of disconnected clients
 * @property {int} connectionCount  Total number of client connections
 * 
 * @public
 * @constructor module:server~SoTradeServer
 * @augments module:stbuscomponent~STBusComponent
 */
function SoTradeServer (info) {
	SoTradeServer.super_.apply(this, arguments);
	
	this.httpServer = null;
	this.io = null;
	this.clients = [];
	this.isShuttingDown = false;
	this.creationTime = Date.now() / 1000;
	
	this.deadQueryCount = 0;
	this.deadQueryCompressionInfo = {
		supported: {lzma: 0, s: 0},
		used: {lzma: 0, s: 0, si: 0}
	};
	
	this.connectionCount = 0;
	this.info = info || {};
}

util.inherits(SoTradeServer, buscomponent.BusComponent);

/**
 * Return general and statistical information on this server instance
 * 
 * @param {boolean} qctxDebug  Whether to include debugging information on the local QContexts
 * 
 * @return {object} Returns with most information on a {module:server~SoTradeServer} object
 * @function busreq~internalServerStatistics
 */
SoTradeServer.prototype.internalServerStatistics = buscomponent.provide('internalServerStatistics',
	['qctxDebug'], function(qctxDebug)
{
	if (typeof gc == 'function')
		gc(); // perform garbage collection, if available (e.g. via the v8 --expose-gc option)
	
	var self = this;
	var ret = {
		pid: process.pid,
		hostname: os.hostname(),
		isBackgroundWorker: self.info.isBackgroundWorker,
		creationTime: self.creationTime,
		clients: _.map(self.clients, function(x) { return x.stats(); }),
		bus: self.bus.stats(),
		msgCount: self.msgCount,
		msgLZMACount: self.msgLZMACount,
		connectionCount: self.connectionCount,
		deadQueryCount: self.deadQueryCount,
		deadQueryCompressionInfo: self.deadQueryCompressionInfo,
		deadQueryLZMACount: self.deadQueryCompressionInfo.supported.lzma, // backwards compatibility
		deadQueryLZMAUsedCount: self.deadQueryCompressionInfo.used.lzma, // backwards compatibility
		now: Date.now(),
		qcontexts: qctxDebug ? qctx.QContext.getMasterQueryContext().getStatistics(true) : null
	};
	
	return Q.all([
		self.request({name: 'get-readability-mode'}),
		self.request({name: 'dbUsageStatistics'})
	]).then(function(readonlyReply, dbstats) {
		ret.readonly = readonlyReply.readonly;
		ret.dbstats = dbstats;
		
		return ret;
	});
});

/**
 * Set up the server for listening on HTTP
 * 
 * @param {int} port  The port for this server to listen on
 * 
 * @function module:server~SoTradeServer#start
 */
SoTradeServer.prototype.start = function(port) {
	assert.ok(port);
	debug('Start listening', port);
	
	var self = this;
	var cfg;
	
	return self.getServerConfig().then(function(cfg_) {
		cfg = cfg_;
		
		if (cfg.protocol == 'https')
			self.httpServer = https.createServer(cfg.http);
		else
			self.httpServer = http.createServer();
		
		self.httpServer.on('request', _.bind(self.handleHTTPRequest, self));
		
		return self.listen(port, cfg.wshost);
	}).then(function() {
		self.io = sio.listen(self.httpServer, _.bind(cfg.configureSocketIO, self)(sio, cfg));
		self.io.adapter(busAdapter(self.bus));
		
		self.io.sockets.on('connection', _.bind(self.handleConnection, self));
	});
};

/**
 * Set up the server for listening
 * 
 * @param {int} port  The port for this server to listen on
 * @param {string} host  The host to listen on
 * 
 * @return {object}  A Q promise fulfilled when the server is fully available
 * 
 * @function module:server~SoTradeServer#listen
 */
SoTradeServer.prototype.listen = function(port, host) {
	assert.ok(port);
	
	var self = this;
	var deferred = Q.defer();
	
	var listenSuccess = false;
	
	var listenHandler = function() {
		self.httpServer.on('error', function(e) {
			return self.emitError(e);
		});
		
		listenSuccess = true;
		deferred.resolve();
	};
	
	self.httpServer.once('error', function(e) {
		if (listenSuccess) // only handle pre-listen errors
			return;
		
		self.httpServer.removeListener('listening', listenHandler);
		
		if (e.code != 'EADDRINUSE')
			return deferred.reject(e);
		
		console.log(process.pid, 'has address in use on', port, host);
		deferred.resolve(Q.delay(500).then(function() {
			try {
				self.httpServer.close();
			} catch(e2) {
				console.warn(e2);
			}
			
			return self.listen(port, host);
		}));
	});
	
	self.httpServer.addListener('listening', listenHandler);
	
	process.nextTick(function() {
		debug(process.pid, 'listening on', port, host);
		self.httpServer.listen(port, host);
	});
	
	return deferred.promise;
};

/**
 * Handles a single HTTP request in the format of standard
 * node.js HTTP handlers.
 * 
 * @function module:server~SoTradeServer#handleHTTPRequest
 */
SoTradeServer.prototype.handleHTTPRequest = function(req, res) {
	debug('HTTP Request', req.url);
	
	var loc = url.parse(req.url, true);
	if (loc.pathname.match(/^(\/dynamic)?\/?ping/)) {
		res.writeHead(200, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
		res.end('pong');
		return;
	}
	
	if (loc.pathname.match(/^(\/dynamic)?\/?statistics/)) {
		return this.request({name: 'gatherPublicStatistics'}).then(function(result) {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*', 'Cache-Control': 
				'max-age=500'
			});
			res.end(JSON.stringify(result));
		});
	}
	
	this.request({name: 'handleFSDBRequest', 
		request: req,
		result: res,
		requestURL: loc
	}).then(function(isBeingHandled) {
		if (!isBeingHandled) {
			res.writeHead(404, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
			res.end('Hi (not really found)!');
		}
	});
};

/**
 * Handles an incoming connection in the format of standard
 * socket.io connection handlers.
 * 
 * @function module:server~SoTradeServer#handleConnection
 */
SoTradeServer.prototype.handleConnection = function(socket) {
	debug('Incoming connection');
	
	assert.ok(this.bus);
	
	this.connectionCount++;
	
	var d = new ConnectionData(socket);
	assert.ok(d.cdid);
	d.setBus(this.bus, 'cdata-' + d.cdid);
	this.clients.push(d);
};

/**
 * Removes a connection from this server’s list of clients.
 * 
 * @property id  The {module:connectiondata~ConnectionData} identifier
 * 
 * @function busreq~deleteConnectionData
 */
SoTradeServer.prototype.removeConnection = buscomponent.provide('deleteConnectionData', ['id'], function(id) {
	debug('Remove connection', id);
	
	var removeClient = _.find(this.clients, function(client) { return client.cdid == id; });
	
	if (removeClient) {
		this.clients = _.without(this.clients, removeClient);
		this.deadQueryCount          += removeClient.queryCount;
		
		for (var i in removeClient.queryCompressionInfo.supported)
			this.deadQueryCompressionInfo.supported[i] += removeClient.queryCompressionInfo.supported[i];
		for (var i in removeClient.queryCompressionInfo.used)
			this.deadQueryCompressionInfo.used[i] += removeClient.queryCompressionInfo.used[i];
	}
	
	if (this.isShuttingDown)
		this.shutdown();
});

/**
 * Sets this server instance into shutdown mode.
 * 
 * @function module:server~SoTradeServer#shutdown
 */
SoTradeServer.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
	debug('Server shutdown');
	
	this.isShuttingDown = true;
	
	if (this.clients.length == 0) {
		this.emitImmediate('localMasterShutdown');
		if (this.httpServer)
			this.httpServer.close();
		
		this.unplugBus();
	}
});

exports.SoTradeServer = SoTradeServer;

})();
