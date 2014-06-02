(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var http = require('http');
var url = require('url');
var sio = require('socket.io');
var buscomponent = require('./buscomponent.js');
var ConnectionData = require('./connectiondata.js').ConnectionData;

function SoTradeServer () {
	this.httpServer = null;
	this.io = null;
	this.store = null;
	this.clients = [];
	this.isShuttingDown = false;
	this.creationTime = new Date().getTime() / 1000;
	
	this.deadQueryCount = 0;
	this.deadQueryLZMACount = 0;
	this.deadQueryLZMAUsedCount = 0;
	this.connectionCount = 0;
}

util.inherits(SoTradeServer, buscomponent.BusComponent);

SoTradeServer.prototype.gatherServerStatistics = buscomponent.listener('getServerStatistics', function() {
	this.emit('pushServerStatistics', {
		pid: process.pid,
		creationTime: this.creationTime,
		clients: _.map(this.clients, function(x) { return x.stats(); }),
		bus: this.bus.stats(),
		msgCount: this.msgCount,
		msgLZMACount: this.msgLZMACount,
		connectionCount: this.connectionCount,
		deadQueryCount: this.deadQueryCount,
		deadQueryLZMACount: this.deadQueryLZMACount,
		deadQueryLZMAUsedCount: this.deadQueryLZMAUsedCount
	});
});

SoTradeServer.prototype.start = function() {
	this.getServerConfig(function(cfg) {
		this.httpServer = http.createServer();
		this.httpServer.on('request', _.bind(this.handleHTTPRequest, this));
		this.httpServer.listen(cfg.wsport, cfg.wshost);
		
		this.io = sio.listen(this.httpServer);
		
		this.io.configure('production', _.bind(function() {
			this.io.enable('browser client minification');
			this.io.enable('browser client etag');
			this.io.enable('browser client gzip');
			this.io.set('log level', 1);
		}, this));
		
		this.io.configure(_.bind(cfg.configureSocketIO || function() {}, this, sio, cfg));
		assert.ok(this.store);
		
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
	
	this.clients = _.without(this.clients, removeClient);
	this.deadQueryCount         += removeClient.queryCount;
	this.deadQueryLZMACount     += removeClient.queryLZMACount;
	this.deadQueryLZMAUsedCount += removeClient.queryLZMAUsedCount;
	
	cb();
	
	if (this.isShuttingDown)
		this.shutdown();
});

SoTradeServer.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
	this.isShuttingDown = true;
	
	if (this.clients.length == 0) {
		this.emit('localMasterShutdown');
		if (this.httpServer)
			this.httpServer.close();
		if (this.store)
			this.store.destroy();
		this.unplugBus();
		
		setTimeout(function() {
			process.exit(0);
		}, 2000);
	}
});

exports.SoTradeServer = SoTradeServer;

})();
