(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var events = require('events');
var os = require('os');
var crypto = require('crypto');
var cytoscape = require('cytoscape');
var lzma = require('lzma-native');
var objectHash = require('object-hash');

function Bus () {
	var self = this;
	
	self.hostname = os.hostname();
	self.pid = process.pid;
	self.id = self.determineBusID();
	self.handledEvents = [];
	
	self.curId = 0;
	self.busGraph = cytoscape({
		headless: true,
		elements: [
			{
				group: 'nodes',
				data: self
			}
		]
	});
	
	self.ownNode = null;
	self.dijkstra = null;
	self.localNodes = null;
	self.busGraphUpdated();
	
	self.setMaxListeners(0);
	self.responseWaiters = {};
	
	self.msgCount = 0;
	self.lostPackets = 0;
	self.busNodeInfoQueued = false;
	
	self.packetLog = [];
	self.packetLogLength = 1536;
	
	self.pingIntervalMs = 85000; // 85 seconds between transport pings
	
	self.components = [];
	self.transports = [];
	self.removedTransports = [];
	
	self.remotesWithOurBusNodeInfo = [];
	
	self.inputFilters = [];
	self.outputFilters = [];
	self.nonLoggedPacketNames = ['bus::nodeInfo'];
	
	self.on('newListener', function(event) {
		if (self.handledEvents.indexOf(event) == -1) {
			self.handledEvents.push(event);
			
			self.emitBusNodeInfoSoon();
		}
	});
	
	self.on('removeListener', function(event) {
		if (self.listeners(event).length == 0) {
			self.handledEvents = _.without(self.handledEvents, event);
			
			assert.ok(self.handledEvents.indexOf(event) == -1);
			
			self.emitBusNodeInfoSoon();
		}
	});
	
	self.on('bus::nodeInfo', function(data) {
		if (!Buffer.isBuffer(data))
			data = new Buffer(data);
		
		lzma.decompress(data, function(data) {
			data = JSON.parse(data);
			assert.ok(data.id && _.isString(data.id));
			assert.ok(data.graph);
			assert.ok(data.handledEvents && _.isArray(data.handledEvents));
			
			if (data.id == self.id)
				return;
			
			self.handleTransportNodeInfo(data);
			
			if (self.remotesWithOurBusNodeInfo.indexOf(data.id) == -1) {
				self.remotesWithOurBusNodeInfo.push(data.id);
				self.emitBusNodeInfoSoon();
			}
		});
	});
	
	assert.notEqual(self.handledEvents.indexOf('bus::nodeInfo'), -1);
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
	var self = this;
	
	var info = {
		id: self.id,
		handledEvents: self.handledEvents,
		graph: self.busGraph.json()
	};

	lzma.compress(JSON.stringify(info), {preset: 3}, function(encodedInfo) {
		// note that initial infos are transport events, whereas
		// non-initial infos are bus events (and therefore bus packets)
		if (initial) {
			transports = transports || self.transports;
			
			for (var i = 0; i < transports.length; ++i)
				transports[i].emit('bus::nodeInfoInitial', encodedInfo);
		} else {
			self.emitGlobal('bus::nodeInfo', encodedInfo);
		}
	});
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
	
	var edgeId = sha256(Math.random() + '.' + Date.now()).substr(0, 8);

	// Do a three-way handshake, similar to TCP
	// This has the purpose of checking connectivity
	// for both outgoing and incoming events
	transport.on('bus::handshakeSYN', function(d) {
		if (d.id == self.id)
			return;
		
		if (d.edgeId < edgeId)
			edgeId = d.edgeId; // take minimum
		
		transport.emit('bus::handshakeSYNACK', {id: self.id, edgeId: edgeId});
		self.emitBusNodeInfo([transport], true);
	});
	
	transport.on('bus::handshakeSYNACK', function(d) {
		if (d.id == self.id)
			return;
		
		if (d.edgeId < edgeId)
			edgeId = d.edgeId; // take minimum
		
		self.emitBusNodeInfo([transport], true);
	});
	
	transport.emit('bus::handshakeSYN', {id: self.id, edgeId: edgeId});
	
	var pingInterval = null, disconnected = false, waitingForPing = false;
	transport.on('bus::nodeInfoInitial', function(data) { // ~ ACK after SYN-ACK
		if (!Buffer.isBuffer(data))
			data = new Buffer(data);
		
		lzma.decompress(data, function(data) {
			data = JSON.parse(data);
			if (data.id == self.id)
				return;
			
			self.handleTransportNodeInfo(data, true); // modifies busGraph property!
			
			var nodeIDs = [data.id, self.id].sort(); // sort for normalization across nodes
			var transportGraphID = nodeIDs.join('-') + '-' + edgeId;
			
			assert.ok(self.busGraph.getElementById(nodeIDs[0]).isNode());
			assert.ok(self.busGraph.getElementById(nodeIDs[1]).isNode());
			
			// remove the edge, if present, since it may have been updated
			// during reading the remote node info (in which case emit() & co are missing!)
			self.busGraph.remove(self.busGraph.getElementById(transportGraphID));
			
			transport.source = nodeIDs[0];
			transport.target = nodeIDs[1];
			transport.id = transportGraphID;
			transport.msgCount = 0;
			
			self.busGraph.add({
				group: 'edges',
				data: transport
			});
			
			self.busGraphUpdated();
			
			self.transports.push(transport);
			
			self.emitBusNodeInfoSoon();
			
			if (!transport.noPingWeight && pingInterval === null) {
				// pings are sent, again, in a TCP-handshake-like manner, i.e.
				// A->B, B->A, A->B (indicated by the “stage” counter)
				var emitInitialPing = function() {
					if (disconnected)
						return;
					
					if (waitingForPing) // ping larger than interval
						transport.weight = self.pingIntervalMs;
					
					waitingForPing = true;
					transport.emit('bus::ping', {outTime: Date.now(), stage: 0});
				};
				
				pingInterval = setInterval(emitInitialPing, self.pingIntervalMs);
				process.nextTick(emitInitialPing);
			}
			
			if (!doneCalled) {
				doneCalled = true;
				done();
			}
		});
	});
	
	transport.on('bus::ping', function(data) {
		assert.strictEqual(parseInt(data.outTime), data.outTime);
		assert.strictEqual(parseInt(data.stage), data.stage);
		
		var now = Date.now();
		waitingForPing = false;
		
		var oldWeight = transport.weight;
		if (data.stage > 0) {
			transport.weight = now - data.outTime;
			
			if (transport.weight != oldWeight)
				self.emitBusNodeInfoSoon();
		}
		
		if (data.stage < 2 && !disconnected)
			transport.emit('bus::ping', {outTime: data.outTime, stage: data.stage + 1});
	});
	
	transport.on('bus::packet', function(p) {
		if (p.seenBy.indexOf(self.id) != -1)
			return;
		
		transport.msgCount++;
		
		self.handleBusPacket(p);
	});
	
	transport.on('disconnect', function() {
		if (pingInterval !== null) {
			clearInterval(pingInterval);
			pingInterval = null;
		}
		
		self.removedTransports.push(transport.id);
		self.busGraph.remove(self.busGraph.getElementById(transport.id));
		
		var tIndex = self.transports.indexOf(transport);
		assert.ok(tIndex != -1 || !doneCalled);
		if (tIndex != -1)
			self.transports.splice(tIndex, 1); // remove from transports list
		
		self.localizeBusGraph();
		
		self.busGraphUpdated();
	});
};

Bus.prototype.localizeBusGraph = function() {
	// reload the graph, choosing only the current connected component
	var ownNode = this.busGraph.getElementById(this.id);
	assert.ok(ownNode && ownNode.isNode());
	
	var cc = this.busGraph.elements().connectedComponent(this.busGraph.getElementById(this.id));
	this.busGraph.load(cc.map(function(e) { return e.json(); }));
	assert.ok(this.busGraph.elements().length > 0);
};

Bus.prototype.handleTransportNodeInfo = function(busnode, doNotLocalize) {
	var remoteBusGraph = cytoscape(busnode.graph);
	if (remoteBusGraph.gHash() == this.busGraph.gHash())
		return;
	
	/*if (remoteBusGraph.getElementById(busnode.id).data().handledEvents.indexOf('client-prod') != -1)
		console.log(this.id, 'knows that', busnode.id, 'handles prod');*/
	
	// remove all own edges from the remote bus graph, then take the union and
	// add our own edges later on
	remoteBusGraph.remove(remoteBusGraph.getElementById(this.id));
	this.busGraph = remoteBusGraph.union(this.busGraph);
	
	// Remove edges from the graph of which the remote node is an endpoint (but we are not)
	// and which are not present in the remote graph;
	// Work with IDs since the nodes are in different Cytoscape instances
	var rEdgesInUnion = this.busGraph.getElementById(busnode.id).edgesWith(this.busGraph.elements()).map(pluckID);
	var rEdgesInRGraph = remoteBusGraph.getElementById(busnode.id).edgesWith(remoteBusGraph.elements()).map(pluckID);
	var ownEdges = this.busGraph.getElementById(this.id).edgesWith(this.busGraph.elements()).map(pluckID);
	var edgesToRemove = _.difference(_.difference(rEdgesInUnion, rEdgesInRGraph), ownEdges);
	
	// remove edges that have been removed locally
	// (the remote may not yet be aware of that fact)
	edgesToRemove = _.union(edgesToRemove, this.removedTransports);
	for (var i = 0; i < edgesToRemove.length; ++i)
		this.busGraph.remove(this.busGraph.getElementById(edgesToRemove[i]));
	
	this.busGraph.getElementById(busnode.id).data().handledEvents = busnode.handledEvents;
	
	// localization can be supressed, e. g. because we just received an initial node info
	// and the edge that keeps the graph connected is yet to be added
	// (localizing refers to taking only the current connected component)
	if (!doNotLocalize)
		this.localizeBusGraph();
	
	// fail early in case we cannot use one of our own edges as a transport
	this.busGraph.getElementById(this.id).edgesWith(this.busGraph.elements()).forEach(function(e) {
		assert.ok(e);
		assert.ok(e.data().emit);
	});
	
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
	
	assert.ok(self.id);
	assert.equal(packet.seenBy.indexOf(self.id), -1);
	packet.seenBy.push(self.id);
	
	assert.ok(packet.recipients.length > 0);
	
	var nextTransports = {};
	
	var packetIsForSelf = false;
	for (var i = 0; i < packet.recipients.length; ++i) {
		var recpId = packet.recipients[i];
		assert.ok(recpId);
		assert.ok(_.isString(recpId));
		assert.ok(packet.seenBy.length > 0);
		
		if (recpId == self.id) {
			// defer handling, since we might have received a message which invalidates the bus graph
			packetIsForSelf = true;
		} else {
			var targetNode = self.busGraph.getElementById(recpId);
			
			if (!targetNode || !targetNode.isNode()) {
				self.lostPackets++;
				continue;
			}
			
			var path = self.dijkstra.pathTo(targetNode);
			
			// path.length >= 3: at least source node, edge, target node
			if (!path || path.length < 3) {
				(function() { // use closure so packet_ gets captured per closure
					/* no route -> probably not fully connected yet;
					 * keep packet for a while */
					var packet_ = _.clone(packet);
					
					packet_.recipients = [recpId];
					packet_.seenBy = packet_.seenBy.slice(0, packet_.seenBy.length - 1);
					
					assert.equal(packet_.seenBy.indexOf(self.id), -1);
					setTimeout(function() {
						self.handleBusPacket(packet_);
					}, 10);
				})();
				
				continue;
			}
			
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
		var args = Array.prototype.slice.call(arguments);
		
		self.handleBusPacket(self.filterOutput({
			sender: self.id,
			seenBy: [],
			recipients: [req.sender],
			args: args,
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
	
	var requestId = self.id + '-' + (self.curId++);
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
					// re-send in case the packet got lost (disconnect or similar)
					if (responsePackets.length == 0)
						return self.requestScoped(req, onReply, scope);
					
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
		busGraph: this.busGraph.json(),
		packetLogCount: this.packetLog.length,
		packetLogLength: this.packetLogLength
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

/* cytoscape graph hashing extension */
cytoscape('core', 'gHash', function() {
	var nodes = this.nodes();
	
	var nodeData = {};
	nodes.forEach(function(v) {
		nodeData[v.id()] = [
			v.data().handledEvents,
			v.edgesWith(nodes).map(function(e) { return e.id(); }).sort()
		];
	});
	
	return objectHash(nodeData);
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

function pluckID(e) {
	return e.id();
}

})();
