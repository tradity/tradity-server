(function () { "use strict";

var _ = require('underscore');
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

function SoTradeServer () {
	SoTradeServer.super_.apply(this, arguments);
	
	this.httpServer = null;
	this.io = null;
	this.store = null;
	this.clients = [];
	this.isShuttingDown = false;
	this.creationTime = Date.now() / 1000;
	
	this.deadQueryCount = 0;
	this.deadQueryLZMACount = 0;
	this.deadQueryLZMAUsedCount = 0;
	this.connectionCount = 0;
}

util.inherits(SoTradeServer, buscomponent.BusComponent);

SoTradeServer.prototype.getServerStatistics = buscomponent.provide('internal-get-server-statistics', ['reply'], function(cb) {
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
		
		this.io.sockets.on('connection', _.bind(this.connectionHandler, this));
	});
};

SoTradeServer.prototype.handleHTTPRequest = function(req, res) {
	var loc = url.parse(req.url, true);
	if (loc.pathname.match(/^(\/dynamic)?\/?ping/)) {
		res.writeHead(200, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
		res.end('pong');
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

SoTradeServer.prototype.connectionHandler = function(socket) {
	assert.ok(this.bus);
	
	this.connectionCount++;
	
	var d = new ConnectionData(socket);
	assert.ok(d.cdid);
	d.setBus(this.bus, 'cdata-' + d.cdid);
	this.clients.push(d);
};

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

SoTradeServer.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
	this.isShuttingDown = true;
	
	if (this.clients.length == 0) {
		this.emitImmediate('localMasterShutdown');
		if (this.httpServer)
			this.httpServer.close();
		if (this.store)
			this.store.unref();
		this.unplugBus();
		
		setTimeout(function() {
			process.exit(0);
		}, 2000);
	}
});

exports.SoTradeServer = SoTradeServer;

})();
