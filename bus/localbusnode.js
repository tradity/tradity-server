(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var events = require('events');
var os = require('os');
var hash = require('mhash').hash;
var cytoscape = require('cytoscape');

function LocalBusNode () {
	// BusNode properties
	this.id = this.determineBusID();
	this.handledEvents = [];
	// End BusNode properties
	
	this.curId = 0;
	this.busGraph = cytoscape({
		headless: true,
		elements: [
			{
				group: 'nodes',
				data: this
			}
		]
	});
	
	this.setMaxListeners(0);
	this.responseWaiters = {};
	
	this.msgCount = 0;
	
	this.on('newListener', function(data) {
		if (this.handledEvents.indexOf(data.event) == -1) {
			this.handledEvents.push(data.event);
			
			this.emit('busNodeAcceptsEvent', {name: data.event});
		}
	});
	
	this.on('removeListener', function(data) {
		if (this.listeners(data.event).length == 0) {
			this.handledEvents = _.without(this.handledEvents, data.event);
			
			assert.ok(this.handledEvents.indexOf(data.event) == -1);
			
			this.emit('busNodeRefusesEvent', {name: data.event});
		}
	});
	
	this.transports = [];
}

util.inherits(LocalBusNode, events.EventEmitter);

LocalBusNode.prototype.determineBusID = function() {
	// return hostname and hash of network interfaces, process id, current time
	return os.hostname() + '-' + hash('sha256', JSON.stringify(os.networkInterfaces()) + '|' +
		process.pid + '|' + Date.now()).substr(0, 12);
};

LocalBusNode.prototype.emitBusNodeInfo = function(transports) {
	transports = transports || this.transports;
	
	for (var i = 0; i < transports.length; ++i) {
		transport[i].emit('busNodeInfo', {
			id: this.id,
			handledEvents: this.handledEvents,
			graph: this.busGraph.json()
		});
	}
}

LocalBusNode.prototype.addTransport = function(transport) {
	var self = this;
	
	assert.ok(transport.weight || transport.weight === 0);
	
	self.emitBusNodeInfo([transport]);
	
	transport.on('busNodeInfo', function(data) {
		if (data.id == self.id)
			return;
		
		self.handleTransportNodeInfo(data); // modifies busGraph property!
		
		var nodeIDs = [data.id, this.id].sort(); // sort for normalization
		var src = self.busGraph.getElementById(nodeIDs[0].id);
		var dst = self.busGraph.getElementById(nodeIDs[1].id);
		
		assert.ok(src && src.isNode());
		assert.ok(dst && dst.isNode());
		
		var presentEdges = src.edgesWith(dst);
		if (!presentEdges.data()) {
			// edge not present in graph -> add it
			
			transport.source = src;
			transport.target = dst;
			transport.id = nodeIDs.join('-');
			transport.msgCount = 0;
			
			self.busGraph.add({
				group: 'edges',
				data: transport
			});
			
			self.transports.push(transport);
			
			self.emitBusNodeInfo();
		}
	});
	
	transport.on('busPacket', function(p) {
		transport.msgCount++;
		
		self.handleBusPacket(p);
	});
};

LocalBusNode.prototype.handleTransportNodeInfo = function(busnode) {
	this.busGraph = cytoscapeUnion(this.busGraph, busnode.graph);
	this.busGraph.getElementById(busnode.id).data().handledEvents = busnode.handledEvents;
};

LocalBusNode.prototype.handleBusPacket = function(packet) {
	var self = this;
	
	self.msgCount++;
	
	assert.notEqual(packet.seenBy.indexOf(self.id), -1);
	packet.seenBy.push(self.id);
	
	var rootNode = self.busGraph.getElementById(self.id);
	assert.ok(rootNode && rootNode.isNode());
	assert.ok(packet.recipients.length > 0);
	
	// provides dijkstra’s algorithm, starting with rootNode
	var dijkstra = self.busGraph.elements().dijkstra(rootNode, function(edge) { return edge.weight; });
	
	var nextTransports = {};
	
	for (var i = 0; i < packet.recipients.length; ++i) {
		var recpId = packet.recipients[i].id;
		
		if (recpId == self.id) {
			self.handleIncomingPacket(packet);
		} else {
			var targetNode = self.busGraph.getElementById(recpId);
			
			assert.ok(targetNode && targetNode.isNode());
			
			var path = dijkstra.pathTo(targetNode);
			assert.ok(path);
			
			// add recipient id to recipient list for this transport
			var nextTransport = path[1].data();
			if (nextTransports[nextTransport.id])
				nextTransports[nextTransport.id].push(recpId);
			else
				nextTransports[nextTransport.id] = {transport: nextTransport, recipients: [recpId]};
		}
	}
	
	for (var i in nextTransports) {
		var transport = nextTransports[i].transport;
		var packet_ = _.clone(packet);
		packet_.recipients = nextTransports[i].recipients;
		
		transport.emit('busPacket', packet_);
	}
};

LocalBusNode.prototype.handleIncomingPacket = function(packet) {
	var self = this;
	
	switch (packet.type) {
		case 'event':
			self.handleIncomingEmit(packet);
			break;
		case 'request':
			self.handleIncomingRequest(packet);
			break;
		case 'response':
			self.handleIncomingResponse(packet);
			break;
		default:
			assert.fail(packet.name, 'event or request or response');
			break;
	}
};

LocalBusNode.prototype.handleIncomingEmit = function(packet) {
	return events.EventEmitter.prototype.emit.apply(this, [packet.name, packet.data]);
};

LocalBusNode.prototype.handleIncomingResponse = function(resp) {
	assert.ok(resp.responseTo);
	assert.ok(this.responseWaiters[resp.responseTo]);
	
	this.responseWaiters[resp.responseTo].handleResponse(resp);
};

LocalBusNode.prototype.handleIncomingRequest = function(req) {
	assert.ok(req.name);
	assert.ok(req.data);
	assert.ok(!req.data.reply);
	
	req.data.reply = function() {
		this.handleBusPacket({
			sender: this.id,
			seenBy: [],
			recipients: [req.sender]
			args: Array.prototype.slice.call(arguments),
			responseTo: req.requestId
			type: 'response'
		});
	};
	
	return events.EventEmitter.prototype.emit.apply(this, [req.name, req.data]);
};

LocalBusNode.prototype.expandScope = function(scope, eventType) {
	switch (scope) {
		case 'local':
			scope = [this.id];
			break;
		case 'nearest':
			// take a shortcut if we provide the relevant event ourselves
			// this proably happens quite often
			if (this.handledEvents.indexOf(eventType) != -1) {
				scope = [this.id];
				break;
			}
			
			// determine all nodes accepting our eventType
			var possibleTargetNodes = this.busGraph.nodes().filter(function(i, e) {
				return e.handledEvents.indexOf(eventType) != -1;
			});
			
			// find nearest of these
			var dijkstra = this.busGraph().elements().dijkstra(this.busGraph.getElementById(this.id), function(edge) {
				return edge.weight;
			});
			
			scope = [_.min(possibleTargetNodes, function(e) {
				return dijkstra.distanceTo(e);
			})];
			break;
		case 'global':
			scope = this.busGraph.nodes().map(function(e) { return e.id(); });
			break;
		default:
			assert.ok(_.isArray(scope));
			break;
	}
	
	return scope;
};

LocalBusNode.prototype.emit = function(name, data, scope) {
	var recipients = this.expandScope(scope, name);
	
	this.handleBusPacket({
		sender: this.id,
		seenBy: [],
		name: name,
		data: data,
		recipients: recipients,
		type: 'event'
	});
};

LocalBusNode.prototype.request = function(req, onReply, scope) {
	assert.ok(req);
	
	req = _.clone(req);
	assert.ok(req.name);
	assert.ok(!req.requestId);
	assert.ok(!req.reply);
	
	onReply = onReply || function() {};
	
	var requestId = this.id + '-' + (++this.curId);
	req.requestId = requestId;
	
	var recipients = this.expandScope(scope, req.name);
	
	// scope is now array of target ids
	assert.ok(_.isArray(scope));
	
	var send = (function() { // inline function so code is in chronological order
		this.handleBusPacket({
			sender: this.id,
			seenBy: [],
			name: req.name,
			data: req,
			recipients: recipients,
			type: 'request',
			singleResponse: scope == 'nearest'
		});
	});
	
	var responsePackets = [];
	this.responseWaiters[requestId] = {
		handleResponse: function(responsePacket) {
			assert.ok(responsePacket.sender);
			
			responsePackets.push(responsePacket);
			
			// all responses in?
			if (responsePackets.length != recipients.length) 
				return; // wait until they are
			
			delete this.responseWaiters[requestId];
			
			try {
				if (scope == 'nearest') {
					assert.equal(responsePackets.length, 1);
					
					onReply.apply(this, responsePackets[0].arguments);
				else
					onReply(_.pluck(responsePackets, 'arguments'));
			} catch (e) {
				this.emit('error', e);
			}
		},
		
		unanswered: function(resp) {
			return _.difference(recipients, _.map(responsePackets, function(e) { return e.sender; }));
		}
	};
	
	send();
};

LocalBusNode.prototype.stats = function() {
	return {
		unanswered: _.keys(this.responseWaiters).length,
		msgCount: this.msgCount,
		id: this.id
	};
};

exports.LocalBusNode = LocalBusNode;

cytoscape('core', 'union', function(g2) {
	var g2 = this;
	
	var elements = [];
	g1 = g1.json();
	g2 = g2.json();
	
	var ids = {};
	var lists = [g1.elements.nodes, g2.elements.nodes, g1.elements.edges, g2.elements.edges];
	
	for (var i = 0; i < lists.length; ++i) {
		for (var j = 0; j < lists[i].length; ++j) {
			var e = lists[i][j];
			
			if (ids[e.data.id]) {
				assert.equal(e.group, ids[e.data.id]);
				continue;
			}
			
			ids[e.data.id] = e.group;
			elements.push(e);
		}
	}
	
	return cytoscape({elements: elements});
});

})();
