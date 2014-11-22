(function () { "use strict";

var _ = require('lodash');
var os = require('os');
var util = require('util');
var assert = require('assert');
var http = require('http');
var https = require('https');
var url = require('url');
var sio = require('socket.io');
var busAdapter = require('./bus/socket.io-bus.js').busAdapter;
var buscomponent = require('./stbuscomponent.js');
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
 * @property {int} deadQueryLZMACount  Number of queries of disconnected clients supporting LZMA
 * @property {int} deadQueryLZMAUsedCount  Number of queries of disconnected clients employing LZMA
 * @property {int} connectionCount  Total number of client connections
 * 
 * @public
 * @constructor module:server~SoTradeServer
 * @augments module:stbuscomponent~STBusComponent
 */
function SoTradeServer () {
	SoTradeServer.super_.apply(this, arguments);
	
	this.httpServer = null;
	this.io = null;
	this.clients = [];
	this.isShuttingDown = false;
	this.creationTime = Date.now() / 1000;
	
	this.deadQueryCount = 0;
	this.deadQueryLZMACount = 0;
	this.deadQueryLZMAUsedCount = 0;
	this.connectionCount = 0;
}

util.inherits(SoTradeServer, buscomponent.BusComponent);

/**
 * Return general and statistical information on this server instance
 * 
 * @return {object} Returns with most information on a {module:server~SoTradeServer} object
 * @function busreq~internalServerStatistics
 */
SoTradeServer.prototype.internalServerStatistics = buscomponent.provide('internalServerStatistics',
	['reply'], function(cb)
{
	var self = this;
	
	self.request({name: 'get-readability-mode'}, function(reply) {
		cb({
			readonly: reply.readonly,
			pid: process.pid,
			hostname: os.hostname(),
			isBackgroundWorker: process.isBackgroundWorker,
			creationTime: self.creationTime,
			clients: _.map(self.clients, function(x) { return x.stats(); }),
			bus: self.bus.stats(),
			msgCount: self.msgCount,
			msgLZMACount: self.msgLZMACount,
			connectionCount: self.connectionCount,
			deadQueryCount: self.deadQueryCount,
			deadQueryLZMACount: self.deadQueryLZMACount,
			deadQueryLZMAUsedCount: self.deadQueryLZMAUsedCount,
			now: Date.now()
		});
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
	this.getServerConfig(function(cfg) {
		if (cfg.http.secure)
			this.httpServer = https.createServer(cfg.http);
		else
			this.httpServer = http.createServer();
		
		this.httpServer.on('request', _.bind(this.handleHTTPRequest, this));
		this.httpServer.listen(port, cfg.wshost);
		
		this.io = sio.listen(this.httpServer, _.bind(cfg.configureSocketIO, this)(sio, cfg));
		
		this.io.adapter(busAdapter(this.bus));
		
		this.io.sockets.on('connection', _.bind(this.handleConnection, this));
	});
};

/**
 * Handles a single HTTP request in the format of standard
 * node.js HTTP handlers.
 * 
 * @function module:server~SoTradeServer#handleHTTPRequest
 */
SoTradeServer.prototype.handleHTTPRequest = function(req, res) {
	var loc = url.parse(req.url, true);
	if (loc.pathname.match(/^(\/dynamic)?\/?ping/)) {
		res.writeHead(200, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
		res.end('pong');
		return;
	}
	
	if (loc.pathname.match(/^(\/dynamic)?\/?statistics/)) {
		this.request({name: 'gatherPublicStatistics'}, function(result) {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*', 'Cache-Control': 
				'max-age=500'
			});
			res.end(JSON.stringify(result));
		});

		return;
	}
	
	this.request({name: 'handleFSDBRequest', 
		request: req,
		result: res,
		requestURL: loc
	}, function(isBeingHandled) {
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
SoTradeServer.prototype.removeConnection = buscomponent.provide('deleteConnectionData', ['id', 'reply'], function(id, cb) {
	var removeClient = _.find(this.clients, function(client) { return client.cdid == id; });
	
	if (removeClient) {
		this.clients = _.without(this.clients, removeClient);
		this.deadQueryCount         += removeClient.queryCount;
		this.deadQueryLZMACount     += removeClient.queryLZMACount;
		this.deadQueryLZMAUsedCount += removeClient.queryLZMAUsedCount;
	}
	
	cb();
	
	if (this.isShuttingDown)
		this.shutdown();
});

/**
 * Sets this server instance into shutdown mode.
 * 
 * @function module:server~SoTradeServer#shutdown
 */
SoTradeServer.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
	this.isShuttingDown = true;
	
	if (this.clients.length == 0) {
		this.emitImmediate('localMasterShutdown');
		if (this.httpServer)
			this.httpServer.close();
		this.unplugBus();
		
		setTimeout(function() {
			process.exit(0);
		}, 2000);
	}
});

exports.SoTradeServer = SoTradeServer;

})();
