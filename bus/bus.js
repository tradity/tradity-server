(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var events = require('events');
var os = require('os');
var crypto = require('crypto');
var cytoscape = require('cytoscape');

function Bus () {
	this.hostname = os.hostname();
	this.pid = process.pid;
	this.id = this.determineBusID();
	this.handledEvents = [];
	
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
	this.ownNode = null;
	this.dijkstra = null;
	this.localNodes = null;
	this.busGraphUpdated();
	
	this.setMaxListeners(0);
	this.responseWaiters = {};
	
	this.msgCount = 0;
	this.lostPackets = false;
	this.busNodeInfoQueued = false;
	
	this.packetLog = [];
	this.packetLogLength = 4096;
	
	this.components = [];
	this.transports = [];
	
	this.inputFilters = [];
	this.outputFilters = [];
	this.nonLoggedPacketNames = ['bus::nodeInfo'];
	
	this.on('newListener', function(event) {
		if (this.handledEvents.indexOf(event) == -1) {
			this.handledEvents.push(event);
			
			this.emitBusNodeInfoSoon();
		}
	});
	
	this.on('removeListener', function(event) {
		if (this.listeners(event).length == 0) {
			this.handledEvents = _.without(this.handledEvents, event);
			
			assert.ok(this.handledEvents.indexOf(event) == -1);
			
			this.emitBusNodeInfoSoon();
		}
	});
	
	this.on('bus::nodeInfo', function(data) {
		this.handleTransportNodeInfo(data);
	});
}

util.inherits(Bus, events.EventEmitter);

Bus.prototype.toJSON = function() {
	return _.pick(this, 'id', 'handledEvents', 'curId', 'msgCount', 'lostPackets', 'components', 'hostname', 'pid');
};

Bus.prototype.determineBusID = function() {
	// return hostname and hash of network interfaces, process id, current time
	return this.hostname + '-' + sha256(JSON.stringify(os.networkInterfaces()) + '|' +
		this.pid + '|' + Date.now()).substr(0, 12);
};

Bus.prototype.emitBusNodeInfoSoon = function() {
	var self = this;
	
	if (self.busNodeInfoQueued)
		return;
	self.busNodeInfoQueued = true;
	
	process.nextTick(function() {
		self.busNodeInfoQueued = false;
		
		self.emitBusNodeInfo();
	});
};

Bus.prototype.emitBusNodeInfo = function(transports, initial) {
	var info = {
		id: this.id,
		handledEvents: this.handledEvents,
		graph: this.busGraph.json()
	};
	
	// note that initial infos are transport events, whereas
	// non-initial infos are bus events (and therefore bus packets)
	if (initial) {
		transports = transports || this.transports;
		
		for (var i = 0; i < transports.length; ++i)
			transports[i].emit('bus::nodeInfoInitial', info);
	} else {
		this.emit('bus::nodeInfo', info);
	}
}

/*
 * Transport API:
 *  - provides EventEmitter API
 *    - signal "disconnect" to indicate disconnect
 *    - arbitrary signals for bus communication (prefixed with "bus::")
 *  - weight (int)
 *  - isLocal (bool)
 * Properties that are set by bus:
 *  - source
 *  - target
 *  - id
 *  - msgCount
 * It is also strongly recommended that transports have a toJSON() method
 * that hides internal structures via blacklisting.
 */
Bus.prototype.addTransport = function(transport, done) {
	var doneCalled = false;
	var self = this;
	
	done = done || function() {};
	
	assert.ok(transport.weight || transport.weight === 0);
	assert.ok(transport.on);
	assert.ok(transport.emit);
	assert.equal(typeof transport.source, 'undefined');
	assert.equal(typeof transport.target, 'undefined');
	assert.equal(typeof transport.id, 'undefined');
	assert.equal(typeof transport.msgCount, 'undefined');
	
	var edgeId = sha256(Math.random() + '.' + Date.now()).substr(0, 4);

	/* three-way handshake, similar to tcp */
	transport.on('bus::handshakeSYN', function(d) {
		var id = d.id;
		if (id == self.id)
			return;
		
		if (d.edgeId < edgeId)
			edgeId = d.edgeId; // take minimum
		
		transport.emit('bus::handshakeSYNACK', self.id);
		self.emitBusNodeInfo([transport], true);
	});
	
	transport.on('bus::handshakeSYNACK', function(id) {
		if (id == self.id)
			return;
		
		self.emitBusNodeInfo([transport], true);
	});
	
	transport.emit('bus::handshakeSYN', {id: self.id, edgeId: edgeId});
	
	transport.on('bus::nodeInfoInitial', function(data) { // ~ ACK after SYN-ACK
		if (data.id == self.id)
			return;
		
		self.handleTransportNodeInfo(data); // modifies busGraph property!
		
		var nodeIDs = [data.id, self.id].sort(); // sort for normalization
		var src = self.busGraph.getElementById(nodeIDs[0]);
		var dst = self.busGraph.getElementById(nodeIDs[1]);
		
		assert.ok(src && src.isNode());
		assert.ok(dst && dst.isNode());
		
		var presentEdges = src.edgesWith(dst);
		if (!presentEdges.data()) {
			// edge not present in graph -> add it
			
			transport.source = nodeIDs[0];
			transport.target = nodeIDs[1];
			transport.id = nodeIDs.join('-') + '-' + edgeId;
			transport.msgCount = 0;
			
			self.busGraph.add({
				group: 'edges',
				data: transport
			});
			
			self.busGraphUpdated();
			
			self.transports.push(transport);
			
			self.emitBusNodeInfoSoon();
		}
		
		if (!doneCalled) {
			doneCalled = true;
			done();
		}
	});
	
	transport.on('bus::packet', function(p) {
		if (p.seenBy.indexOf(self.id) != -1)
			return;
		
		assert.notStrictEqual(p.sender, self.id);
		
		transport.msgCount++;
		
		self.handleBusPacket(p);
	});
	
	transport.on('disconnect', function() {
		self.busGraph.remove(self.busGraph.getElementById(transport.id));
		
		// reload the graph, choosing only the current connected component
		var ownNode = self.busGraph.getElementById(self.id);
		assert.ok(ownNode && ownNode.isNode());
		
		var cc = self.busGraph.elements().connectedComponent(self.busGraph.getElementById(self.id));
		self.busGraph.load(cc.map(function(e) { return e.json(); }));
		assert.ok(self.busGraph.elements().length > 0);
		
		self.busGraphUpdated();
	});
};

Bus.prototype.handleTransportNodeInfo = function(busnode) {
	this.busGraph = this.busGraph.union(cytoscape(busnode.graph));
	this.busGraph.getElementById(busnode.id).data().handledEvents = busnode.handledEvents;
	
	this.busGraphUpdated();
};

Bus.prototype.busGraphUpdated = function() {
	this.ownNode = this.busGraph.getElementById(this.id);
	
	assert.ok(this.ownNode);
	assert.ok(this.ownNode.isNode());
	
	// provides dijkstra’s algorithm, starting with rootNode
	this.dijkstra = this.busGraph.elements().dijkstra(this.ownNode, function(edge) { return edge.data().weight; });
	
	assert.ok(this.dijkstra.distanceTo);
	assert.ok(this.dijkstra.pathTo);
	
	// select all nodes + local edges, take our connected component and out of these the nodes
	this.localNodes = this.busGraph.filter('node, edge[?isLocal]')
		.connectedComponent(this.busGraph.getElementById(this.id))
		.filter('node');
			
	assert.ok(this.localNodes && this.localNodes.length >= 1);
	
	// inform response waiters that nodes may have been removed and are therefore not able to answer requests
	for (var i in this.responseWaiters) {
		var w = this.responseWaiters[i];
		if (w.handleResponse)
			w.handleResponse(null);
	}
};

Bus.prototype.logPacket = function(packet) {
	if (this.nonLoggedPacketNames.indexOf(packet.name) != -1)
		return;
	
	this.packetLog.push(packet);
	
	if (this.packetLog.length > this.packetLogLength)
		this.packetLog.shift();
};

Bus.prototype.handleBusPacket = function(packet) {
	var self = this;
	
	self.msgCount++;
	self.logPacket(packet);
	
	assert.equal(packet.seenBy.indexOf(self.id), -1);
	packet.seenBy.push(self.id);
	
	assert.ok(packet.recipients.length > 0);
	
	var nextTransports = {};
	
	var packetIsForSelf = false;
	for (var i = 0; i < packet.recipients.length; ++i) {
		var recpId = packet.recipients[i];
		assert.ok(recpId);
		assert.ok(_.isString(recpId));
		
		if (recpId == self.id) {
			// defer handling, since we might have received a message which invalides the bus graph
			packetIsForSelf = true;
		} else {
			var targetNode = self.busGraph.getElementById(recpId);
			
			if (!targetNode || !targetNode.isNode()) {
				self.lostPackets++;
				continue;
			}
			
			var path = self.dijkstra.pathTo(targetNode);
			assert.ok(path);
			assert.ok(path.length >= 3); // at least source node, edge, target node
			
			// add recipient id to recipient list for this transport
			var nextTransport = path[1].data();
			assert.ok(nextTransport);
			assert.ok(nextTransport.emit);
			
			if (nextTransports[nextTransport.id])
				nextTransports[nextTransport.id].recipients.push(recpId);
			else
				nextTransports[nextTransport.id] = {transport: nextTransport, recipients: [recpId]};
		}
	}
	
	for (var i in nextTransports) {
		var transport = nextTransports[i].transport;
		var packet_ = _.clone(packet);
		packet_.recipients = nextTransports[i].recipients;

		transport.msgCount++;
		transport.emit('bus::packet', packet_);
	}
	
	if (packetIsForSelf)
		self.handleIncomingPacket(packet);
};

Bus.prototype.handleIncomingPacket = function(packet) {
	packet = this.filterInput(packet, packet.name);
	
	switch (packet.type) {
		case 'event':
			this.handleIncomingEvent(packet);
			break;
		case 'request':
			this.handleIncomingRequest(packet);
			break;
		case 'response':
			this.handleIncomingResponse(packet);
			break;
		default:
			assert.fail(packet.name, 'event or request or response');
			break;
	}
};

Bus.prototype.handleIncomingEvent = function(packet) {
	assert.ok(packet.name);
	
	return events.EventEmitter.prototype.emit.apply(this, [packet.name, packet.data]);
};

Bus.prototype.handleIncomingResponse = function(resp) {
	assert.ok(resp.responseTo);
	assert.ok(this.responseWaiters[resp.responseTo]);
	
	this.responseWaiters[resp.responseTo].handleResponse(resp);
};

Bus.prototype.handleIncomingRequest = function(req) {
	var self = this;
	
	assert.ok(req.name);
	assert.ok(req.data);
	assert.ok(!req.data.reply);
	assert.ok(req.requestId);
	
	req.data.reply = function() {
		self.handleBusPacket(self.filterOutput({
			sender: self.id,
			seenBy: [],
			recipients: [req.sender],
			args: Array.prototype.slice.call(arguments),
			responseTo: req.requestId,
			type: 'response'
		}, 'response'));
	};
	
	return events.EventEmitter.prototype.emit.apply(self, [req.name, req.data, 'request']);
};

Bus.prototype.expandScope = function(scope, eventType) {
	var self = this;
	
	var eventTypeFilter = function(i, e) {
		return e.isNode() && e.data().handledEvents.indexOf(eventType) != -1;
	};
	
	switch (scope) {
		case 'immediate':
			scope = self.handledEvents.indexOf(eventType) == -1 ? [] : [self.id];
			break;
		case 'local':
			scope = self.localNodes.filter(eventTypeFilter).map(function(e) { return e.id(); });
			break;
		case 'nearest':
			// take a shortcut if we provide the relevant event ourselves
			// self proably happens quite often
			if (self.handledEvents.indexOf(eventType) != -1) {
				scope = [self.id];
				break;
			}
			
			// determine all nodes accepting our eventType
			var possibleTargetNodes = self.busGraph.nodes().filter(eventTypeFilter);
			
			if (possibleTargetNodes.length == 0) {
				scope = [];
				break;
			}
			
			// find nearest of these
			var nearestId = _.min(possibleTargetNodes, function(e) {
				return self.dijkstra.distanceTo(e);
			}).id();
			
			assert.notStrictEqual(nearestId, self.id);
			
			scope = [nearestId];
			break;
		case 'global':
			scope = self.busGraph.filter(eventTypeFilter).map(function(e) { return e.id(); });
			break;
		default:
			break;
	}
	
	assert.ok(_.isArray(scope));
	return scope;
};

Bus.prototype.listAllIds = function() {
	return this.busGraph.elements().map(function(e) { return e.id(); });
};

Bus.prototype.emit = function(name, data) {
	// do not propagate events provided by EventEmitter
	if (name == 'newListener' || name == 'removeListener')
		return events.EventEmitter.prototype.emit.apply(this, [name, data]);
	else
		return this.emitGlobal(name, data);
};

Bus.prototype.emitGlobal = function(name, data) {
	this.emitScoped(name, data, 'global');
};

Bus.prototype.emitLocal = function(name, data) {
	this.emitScoped(name, data, 'local');
};

Bus.prototype.emitImmediate = function(name, data) {
	this.emitScoped(name, data, 'immediate');
};

Bus.prototype.emitScoped = function(name, data, scope) {
	var recipients = this.expandScope(scope, name);
	
	var packet = this.filterOutput({
		sender: this.id,
		seenBy: [],
		name: name,
		data: data,
		recipients: recipients,
		type: 'event'
	}, 'event');
	
	if (recipients.length != 0)
		this.handleBusPacket(packet);
	else
		this.logPacket(packet);
};

Bus.prototype.requestNearest =
Bus.prototype.request = function(req, onReply) {
	this.requestScoped(req, onReply, 'nearest');
};

Bus.prototype.requestImmediate = function(req, onReply) {
	this.requestScoped(req, onReply, 'immediate');
};

Bus.prototype.requestLocal = function(req, onReply) {
	this.requestScoped(req, onReply, 'local');
};

Bus.prototype.requestGlobal = function(req, onReply) {
	this.requestScoped(req, onReply, 'global');
};

Bus.prototype.requestScoped = function(req, onReply, scope) {
	var self = this;
	
	assert.ok(req);
	
	req = _.clone(req);
	assert.ok(req.name);
	assert.ok(!req.reply);
	
	onReply = onReply || function() {};
	
	var requestId = self.id + '-' + (++self.curId);
	var recipients = self.expandScope(scope, req.name);
	
	// scope is now array of target ids
	assert.ok(_.isArray(recipients));
	assert.ok(_.difference(recipients, self.listAllIds()).length == 0);
	
	if (recipients.length == 0) {
		var e = new Error('Nonexistent event/request type: ' + req.name);
		e.nonexistentType = true;
		throw e;
	}
	
	var send = function() { // inline function so code is in chronological order
		self.handleBusPacket(self.filterOutput({
			sender: self.id,
			seenBy: [],
			name: req.name,
			data: req,
			requestId: requestId,
			recipients: recipients,
			type: 'request',
			singleResponse: scope == 'nearest'
		}, 'request'));
	};
	
	var responsePackets = [];
	self.responseWaiters[requestId] = {
		handleResponse: function(responsePacket) {
			if (responsePacket !== null) {
				assert.ok(responsePacket.sender);
				
				responsePackets.push(responsePacket);
			}
			
			var availableRecipients = self.listAllIds();
			
			// all responses in?
			if (responsePackets.length != _.intersection(availableRecipients, recipients).length) 
				return; // wait until they are
			
			delete self.responseWaiters[requestId];
			
			try {
				if (scope == 'nearest') {
					assert.equal(responsePackets.length, 1);
					
					onReply.apply(self, responsePackets[0].args);
				} else {
					onReply(_.pluck(responsePackets, 'args'));
				}
			} catch (e) {
				self.emit('error', e);
			}
		},
		
		unanswered: function(resp) {
			return _.difference(recipients, _.map(responsePackets, function(e) { return e.sender; }));
		}
	};
	
	send();
};

Bus.prototype.stats = function() {
	return {
		unanswered: _.keys(this.responseWaiters).length,
		msgCount: this.msgCount,
		lostPackets: this.lostPackets,
		id: this.id,
		components: this.components,
		busGraph: this.busGraph.json()
	};
};

Bus.prototype.unansweredRequests = function() {
	return _.keys(this.responseWaiters);
};

Bus.prototype.filterInput = function(packet, type) {
	return this.applyFilter(this.inputFilters, packet, type);
};

Bus.prototype.filterOutput = function(packet, type) {
	return this.applyFilter(this.outputFilters, packet, type);
};

Bus.prototype.applyFilter = function(filterList, packet, type) {
	for (var i = 0; i < filterList.length; ++i) {
		packet = filterList[i](packet, type);
		assert.ok(packet);
	}
	
	return packet;
};

Bus.prototype.addInputFilter = function(filter) {
	this.inputFilters.push(filter);
};

Bus.prototype.addOutputFilter = function(filter) {
	this.outputFilters.push(filter);
};

Bus.prototype.addComponent = function(componentName) {
	this.components.push(componentName);
};

Bus.prototype.removeComponent = function(componentName) {
	this.components = _.without(this.components, componentName);
};

exports.Bus = Bus;

/* cytoscape connected component extension */
cytoscape('collection', 'connectedComponent', function(root) {
	return this.breadthFirstSearch(root).path.closedNeighborhood();
});

/* cytoscape graph union extension */
cytoscape('core', 'union', function(g2) {
	var g1 = this;
	
	var elements = [];
	g1 = g1.json();
	g2 = g2.json();
	
	var ids = {};
	var lists = [g1.elements.nodes, g2.elements.nodes, g1.elements.edges, g2.elements.edges];
	
	for (var i = 0; i < lists.length; ++i) {
		if (!lists[i])
			continue;
		
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

function sha256(s) {
	var h = crypto.createHash('sha256');
	h.end(s);
	return h.read().toString('hex');
}

})();