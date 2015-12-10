(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var events = require('promise-events');
var os = require('os');
var crypto = require('crypto');
var cytoscape = require('cytoscape');
var zlib = require('zlib');
var objectHash = require('object-hash');
var Q = require('q');

var debug = require('debug')('sotrade:bus');
var debugEvents = require('debug')('sotrade:bus:events');
var debugPackets = require('debug')('sotrade:bus:packets');
var debugNetwork = require('debug')('sotrade:bus:network');
var debugTransport = require('debug')('sotrade:bus:transport');
var debugMisc = require('debug')('sotrade:bus:misc');

class Bus extends events.EventEmitter {
	constructor() {
		super();
		
		this.hostname = os.hostname();
		this.pid = process.pid;
		this.id = this.determineBusID();
		this.handledEvents = new Set();
		
		debug('Creating bus', this.id);
		
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
		this.lostPackets = 0;
		this.busNodeInfoQueued = false;
		
		this.pingIntervalMs = 45000; // 45 seconds between transport pings
		
		this.transports = [];
		this.removedTransports = [];
		
		this.remotesWithOurBusNodeInfo = [];
		
		this.inputFilters = [];
		this.outputFilters = [];
		
		this.on('newListener', event => {
			debugEvents('Add new listener', this.id, event);
			
			if (!this.handledEvents.has(event)) {
				this.handledEvents.add(event);
				
				this.emitBusNodeInfoSoon();
			}
		});
		
		this.on('removeListener', event => {
			debugEvents('Remove listener', this.id, event);
			if (this.listeners(event).length == 0) {
				this.handledEvents.delete(event);
				
				this.emitBusNodeInfoSoon();
			}
		});
		
		this.on('bus::nodeInfo', data => {
			debugNetwork('Received nodeInfo', this.id);
			if (!Buffer.isBuffer(data))
				data = new Buffer(data);
			
			zlib.inflateRaw(data, (error, data) => {
				if (error)
					return this.emit('error', error);
				
				try {
					data = JSON.parse(data);
				} catch (e) {
					return this.emit('error', new Error('Error parsing JSON data: ' + data + ', message = ' + e.message));
				}
				
				assert.ok(data.id && _.isString(data.id));
				assert.ok(data.graph);
				assert.ok(data.handledEvents && _.isArray(data.handledEvents));
				
				if (data.id == this.id)
					return;
				
				debugNetwork('Parsed nodeInfo', this.id + ' <- ' + data.id);
				
				this.handleTransportNodeInfo(data);
				
				if (this.remotesWithOurBusNodeInfo.indexOf(data.id) == -1) {
					this.remotesWithOurBusNodeInfo.push(data.id);
					this.emitBusNodeInfoSoon();
				}
			});
		});
		
		assert.ok(this.handledEvents.has('bus::nodeInfo'));
		
		debug('Created bus', this.id);
	}
	
	toJSON() {
		return {
			id: this.id,
			handledEvents: Array.from(this.handledEvents),
			curId: this.curId,
			msgCount: this.msgCount,
			lostPackets: this.lostPackets,
			hostname: this.hostname,
			pid: this.pid
		}
	}

	determineBusID() {
		// return hostname and hash of network interfaces, process id, current time
		return this.hostname + '-' + sha256(JSON.stringify(os.networkInterfaces()) + '|' +
			this.pid + '|' + Date.now() + '|' + Math.random()).substr(0, 12);
	}

	emitBusNodeInfoSoon() {
		if (this.busNodeInfoQueued)
			return;
		this.busNodeInfoQueued = true;
		
		debugNetwork('emitBusNodeInfoSoon', this.id);
		
		return Q.delay(100).then(() => {
			this.busNodeInfoQueued = false;
			
			this.emitBusNodeInfo();
		});
	}

	emitBusNodeInfo(transports, initial) {
		var info = {
			id: this.id,
			handledEvents: Array.from(this.handledEvents),
			graph: this.busGraph.json()
		};
		
		debugNetwork('emitBusNodeInfo', this.id,
			'with transports ' + (transports || []).map(t => t.id).join(' '),
			initial ? 'initial' : 'non-initial');

		zlib.deflateRaw(JSON.stringify(info), (error, encodedInfo) => {
			if (error)
				return this.emit('error', error);
			
			// note that initial infos are transport events, whereas
			// non-initial infos are bus events (and therefore bus packets)
			if (initial) {
				transports = transports || this.transports;
				
				for (var i = 0; i < transports.length; ++i)
					transports[i].emit('bus::nodeInfoInitial', encodedInfo);
			} else {
				this.emitGlobal('bus::nodeInfo', encodedInfo);
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
	addTransport(transport, done) {
		var doneCalled = false;
		
		done = done || _.noop;
		
		assert.ok(transport.weight || transport.weight === 0);
		assert.ok(transport.on);
		assert.ok(transport.emit);
		assert.equal(typeof transport.source, 'undefined');
		assert.equal(typeof transport.target, 'undefined');
		assert.equal(typeof transport.id, 'undefined');
		assert.equal(typeof transport.msgCount, 'undefined');
		
		var edgeId = sha256(Math.random() + '.' + Date.now()).substr(0, 8);
		
		debugTransport('Create transport/edge', this.id, edgeId);
		
		// Do a three-way handshake, similar to TCP
		// This has the purpose of checking connectivity
		// for both outgoing and incoming events
		transport.on('bus::handshakeSYN', d => {
			debugTransport('Transport SYN', this.id, edgeId, d.id, d.edgeId);
			
			if (d.id == this.id)
				return;
			
			if (d.edgeId < edgeId)
				edgeId = d.edgeId; // take minimum
			
			transport.emit('bus::handshakeSYNACK', {id: this.id, edgeId: edgeId});
			this.emitBusNodeInfo([transport], true);
		});
		
		transport.on('bus::handshakeSYNACK', d => {
			debugTransport('Transport SYN/ACK', this.id, edgeId, d.id, d.edgeId);
			
			if (d.id == this.id)
				return;
			
			if (d.edgeId < edgeId)
				edgeId = d.edgeId; // take minimum
			
			this.emitBusNodeInfo([transport], true);
		});
		
		transport.emit('bus::handshakeSYN', {id: this.id, edgeId: edgeId});
		
		var pingInterval = null, disconnected = false, waitingForPing = false;
		transport.on('bus::nodeInfoInitial', data => { // ~ ACK after SYN-ACK
			if (!Buffer.isBuffer(data))
				data = new Buffer(data);
			
			zlib.inflateRaw(data, (error, data) => {
				if (error)
					return this.emit('error', error);
				
				data = JSON.parse(data);
				if (data.id == this.id)
					return;
				
				debugTransport('Received initial bus node info', this.id, edgeId, data.id);
				
				this.handleTransportNodeInfo(data, true); // modifies busGraph property!
				
				var nodeIDs = [data.id, this.id].sort(); // sort for normalization across nodes
				var transportGraphID = nodeIDs.join('-') + '-' + edgeId;
				
				assert.ok(this.busGraph.getElementById(nodeIDs[0]).isNode());
				assert.ok(this.busGraph.getElementById(nodeIDs[1]).isNode());
				
				// remove the edge, if present, since it may have been updated
				// during reading the remote node info (in which case emit() & co are missing!)
				this.busGraph.remove(this.busGraph.getElementById(transportGraphID));
				
				transport.source = nodeIDs[0];
				transport.target = nodeIDs[1];
				transport.id = transportGraphID;
				transport.msgCount = 0;
				
				this.busGraph.add({
					group: 'edges',
					data: transport
				});
				
				this.busGraphUpdated();
				
				this.transports.push(transport);
				
				this.emitBusNodeInfoSoon();
				
				if (!transport.noPingWeight && pingInterval === null) {
					// pings are sent, again, in a TCP-handshake-like manner, i.e.
					// A->B, B->A, A->B (indicated by the “stage” counter)
					var emitInitialPing = () => {
						if (disconnected)
							return;
						
						/*if (waitingForPing) // ping larger than interval
							transport.weight = this.pingIntervalMs;*/
						
						waitingForPing = true;
						transport.emit('bus::ping', {outTime: Date.now(), stage: 0});
					};
					
					pingInterval = setInterval(emitInitialPing, this.pingIntervalMs);
					process.nextTick(emitInitialPing);
				}
				
				debugTransport('Handled initial bus node info', this.id, edgeId);
				
				if (!doneCalled) {
					doneCalled = true;
					done();
				}
			});
		});
		
		transport.on('bus::ping', (data) => {
			debugTransport('Received ping', this.id, edgeId, data.stage);
			
			assert.strictEqual(parseInt(data.outTime), data.outTime);
			assert.strictEqual(parseInt(data.stage), data.stage);
			
			var now = Date.now();
			waitingForPing = false;
			
			var oldWeight = transport.weight;
			if (data.stage > 0) {
				/*transport.weight = now - data.outTime;*/
				
				var relativeWeightChange = Math.max(oldWeight, transport.weight) / Math.min(oldWeight, transport.weight);
				
				// more than 33.3 % change
				if (relativeWeightChange != relativeWeightChange || relativeWeightChange > 1.333)
					this.emitBusNodeInfoSoon();
			}
			
			if (data.stage < 2 && !disconnected)
				transport.emit('bus::ping', {outTime: data.outTime, stage: data.stage + 1});
		});
		
		transport.on('bus::packet', (p) => {
			var hasAlreadySeen = p.seenBy.indexOf(this.id) != -1;
			
			debugTransport('Received bus packet', this.id, edgeId, hasAlreadySeen);
			
			if (hasAlreadySeen)
				return;
			
			transport.msgCount++;
			
			this.handleBusPacket(p);
		});
		
		transport.on('disconnect', () => {
			debugTransport('Received transport disconnect', this.id, edgeId);
			
			if (pingInterval !== null) {
				clearInterval(pingInterval);
				pingInterval = null;
			}
			
			this.removedTransports.push(transport.id);
			this.busGraph.remove(this.busGraph.getElementById(transport.id));
			
			var tIndex = this.transports.indexOf(transport);
			assert.ok(tIndex != -1 || !doneCalled);
			if (tIndex != -1)
				this.transports.splice(tIndex, 1); // remove from transports list
			
			this.localizeBusGraph();
			
			this.busGraphUpdated();
			
			debugTransport('Handled transport disconnect', this.id, edgeId);
		});
	}

	localizeBusGraph() {
		var startTime = Date.now();
		
		// reload the graph, choosing only the current connected component
		var ownNode = this.busGraph.getElementById(this.id);
		assert.ok(ownNode && ownNode.isNode());
		
		var cc = this.busGraph.elements().connectedComponent(this.busGraph.getElementById(this.id));
		this.busGraph.load(cc.map(e => e.json()));
		assert.ok(this.busGraph.elements().length > 0);
		
		debugNetwork('Localized bus graph', this.id, (Date.now() - startTime) + ' ms');
	}

	handleTransportNodeInfo(busnode, doNotLocalize) {
		debugNetwork('Handling transport node info', this.id, busnode.id, doNotLocalize);
		
		var remoteBusGraph = cytoscape(busnode.graph);
		if (remoteBusGraph.gHash() == this.busGraph.gHash())
			return;
		
		/*if (remoteBusGraph.getElementById(busnode.id).data().handledEvents.has('client-prod'))
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
		
		this.busGraph.getElementById(busnode.id).data().handledEvents = new Set(busnode.handledEvents);
		
		// localization can be supressed, e. g. because we just received an initial node info
		// and the edge that keeps the graph connected is yet to be added
		// (localizing refers to taking only the current connected component)
		if (!doNotLocalize)
			this.localizeBusGraph();
		
		// fail early in case we cannot use one of our own edges as a transport
		this.busGraph.getElementById(this.id).edgesWith(this.busGraph.elements()).forEach(e => {
			assert.ok(e);
			assert.ok(e.data().emit);
		});
		
		this.busGraphUpdated();
		
		debugNetwork('Handled transport node info', this.id, busnode.id, doNotLocalize);
	}

	busGraphUpdated() {
		this.ownNode = this.busGraph.getElementById(this.id);
		
		assert.ok(this.ownNode);
		assert.ok(this.ownNode.isNode());
		
		// provides dijkstra’s algorithm, starting with rootNode
		this.dijkstra = this.busGraph.elements().dijkstra(this.ownNode, edge => edge.data().weight);
		
		assert.ok(this.dijkstra.distanceTo);
		assert.ok(this.dijkstra.pathTo);
		
		// select all nodes + local edges, take our connected component and out of these the nodes
		this.localNodes = this.busGraph.filter('node, edge[?isLocal]')
			.connectedComponent(this.busGraph.getElementById(this.id))
			.filter('node');
		
		assert.ok(this.localNodes && this.localNodes.length >= 1);
		
		debugNetwork('Checked for local nodes', this.id, this.localNodes.length);
		
		// inform response waiters that nodes may have been removed and are therefore not able to answer requests
		for (var i in this.responseWaiters) {
			var w = this.responseWaiters[i];
			if (w.handleResponse)
				w.handleResponse(null);
		}
	}

	handleBusPacket(packet) {
		this.msgCount++;
		
		assert.ok(this.id);
		assert.equal(packet.seenBy.indexOf(this.id), -1);
		packet.seenBy.push(this.id);
		
		assert.ok(packet.recipients.length > 0);
		
		var nextTransports = {};
		
		var packetIsForthis = false;
		for (var i = 0; i < packet.recipients.length; ++i) {
			var recpId = packet.recipients[i];
			assert.ok(recpId);
			assert.ok(_.isString(recpId));
			assert.ok(packet.seenBy.length > 0);
			
			if (recpId == this.id) {
				// defer handling, since we might have received a message which invalidates the bus graph
				packetIsForthis = true;
			} else {
				var targetNode = this.busGraph.getElementById(recpId);
				
				if (!targetNode || !targetNode.isNode()) {
					this.lostPackets++;
					continue;
				}
				
				var path = this.dijkstra.pathTo(targetNode);
				debugPackets('Path to recipient', this.id, recpId, packet.name, path && path.length);
				
				// path.length >= 3: at least source node, edge, target node
				if (!path || path.length < 3) {
					(() => { // use closure so packet_ gets captured per closure
						/* no route -> probably not fully connected yet;
						 * keep packet for a while */
						var packet_ = _.clone(packet);
						
						packet_.recipients = [recpId];
						packet_.seenBy = packet_.seenBy.slice(0, packet_.seenBy.length - 1);
						
						debugPackets('Re-queueing packet', this.id, recpId, packet.name);
						assert.equal(packet_.seenBy.indexOf(this.id), -1);
						return Q.delay(10).then(() => {
							return this.handleBusPacket(packet_);
						});
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

			debugPackets('Writing packet', this.id, packet_.name, transport.id);
			transport.msgCount++;
			transport.emit('bus::packet', packet_);
		}
		
		if (packetIsForthis)
			this.handleIncomingPacket(packet);
	}

	handleIncomingPacket(packet) {
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
	}

	handleIncomingEvent(packet) {
		debugPackets('Handle incoming event', this.id, packet.name);
		assert.ok(packet.name);
		
		return super.emit(packet.name, packet.data);
	}

	handleIncomingResponse(resp) {
		debugPackets('Handle incoming response', this.id, resp.responseTo);
		assert.ok(resp.responseTo);
		assert.ok(this.responseWaiters[resp.responseTo]);
		
		return this.responseWaiters[resp.responseTo].handleResponse(resp);
	}

	handleIncomingRequest(req) {
		debugPackets('Handle incoming request', this.id, req.name, req.requestId);
		
		assert.ok(req.name);
		assert.ok(req.data);
		assert.ok(!req.data.reply);
		assert.ok(req.requestId);
		
		req.data = _.clone(req.data);
		req.data.reply = (function() {
			debugPackets('Local reply', this.id, req.name, req.requestId);
			
			var args = Array.prototype.slice.call(arguments);
			
			this.handleBusPacket(this.filterOutput({
				sender: this.id,
				seenBy: [],
				recipients: [req.sender],
				args: args,
				responseTo: req.requestId,
				type: 'response'
			}, 'response'));
		}).bind(this);
		
		return super.emit(req.name, req.data, 'request');
	}

	expandScope(scope, eventType) {
		var eventTypeFilter = (i, e) => {
			return e.isNode() && e.data().handledEvents.has(eventType);
		};
		
		switch (scope) {
			case 'immediate':
				scope = !this.handledEvents.has(eventType) ? [] : [this.id];
				break;
			case 'local':
				scope = this.localNodes.filter(eventTypeFilter).map(e => e.id());
				break;
			case 'nearest':
				// take a shortcut if we provide the relevant event ourselves
				// this proably happens quite often
				if (this.handledEvents.has(eventType)) {
					scope = [this.id];
					break;
				}
				
				// determine all nodes accepting our eventType
				var possibleTargetNodes = this.busGraph.nodes().filter(eventTypeFilter);
				
				if (possibleTargetNodes.length == 0) {
					scope = [];
					break;
				}
				
				// find nearest of these
				var nearestId = _.min(
					possibleTargetNodes,
					e => this.dijkstra.distanceTo(e)
				).id();
				
				assert.notStrictEqual(nearestId, this.id);
				
				scope = [nearestId];
				break;
			case 'global':
				scope = this.busGraph.filter(eventTypeFilter).map(e => e.id());
				break;
			default:
				break;
		}
		
		assert.ok(_.isArray(scope));
		return scope;
	}

	listAllIds() {
		return this.busGraph.elements().map(e => e.id());
	}

	emit(name, data) {
		// do not propagate events provided by EventEmitter
		if (name == 'newListener' || name == 'removeListener')
			return super.emit(name, data);
		else
			return this.emitGlobal(name, data);
	}

	emitGlobal(name, data) {
		this.emitScoped(name, data, 'global');
	}

	emitLocal(name, data) {
		this.emitScoped(name, data, 'local');
	}

	emitImmediate(name, data) {
		this.emitScoped(name, data, 'immediate');
	}

	emitScoped(name, data, scope) {
		debugEvents('Emit scoped', this.id, name, scope);
		
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
	}

	request(req, onReply) {
		return this.requestNearest(req, onReply);
	}
	
	requestNearest(req, onReply) {
		this.requestScoped(req, onReply, 'nearest');
	}

	requestImmediate(req, onReply) {
		this.requestScoped(req, onReply, 'immediate');
	}

	requestLocal(req, onReply) {
		this.requestScoped(req, onReply, 'local');
	}

	requestGlobal(req, onReply) {
		this.requestScoped(req, onReply, 'global');
	}

	requestScoped(req, onReply, scope) {
		assert.ok(req);
		
		req = _.clone(req);
		assert.ok(req.name);
		assert.ok(!req.reply);
		
		onReply = onReply || _.noop;
		
		var requestId = this.id + '-' + (this.curId++);
		var recipients = this.expandScope(scope, req.name);
		
		debugEvents('Request scoped', this.id, req.name, requestId, scope, recipients.length);
		
		// scope is now array of target ids
		assert.ok(_.isArray(recipients));
		assert.ok(_.difference(recipients, this.listAllIds()).length == 0);
		
		if (recipients.length == 0) {
			var e = new Error('Nonexistent event/request type: ' + req.name);
			e.nonexistentType = true;
			throw e;
		}
		
		var send = () => { // inline function so code is in chronological order
			this.handleBusPacket(this.filterOutput({
				sender: this.id,
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
		this.responseWaiters[requestId] = {
			handleResponse: responsePacket => {
				if (responsePacket !== null) {
					assert.ok(responsePacket.sender);
					
					responsePackets.push(responsePacket);
				}
				
				var availableRecipients = _.intersection(this.listAllIds(), recipients);
				
				debugEvents('Response packet in', this.id, scope, requestId, responsePackets.length, availableRecipients.length, recipients.length);
				// all responses in?
				if (responsePackets.length != availableRecipients.length) 
					return; // wait until they are
				
				delete this.responseWaiters[requestId];
				
				try {
					if (scope == 'nearest') {
						// re-send in case the packet got lost (disconnect or similar)
						if (responsePackets.length == 0)
							return this.requestScoped(req, onReply, scope);
						
						assert.equal(responsePackets.length, 1);
						
						onReply(...responsePackets[0].args);
					} else {
						onReply(..._.pluck(responsePackets, 'args'));
					}
				} catch (e) {
					this.emit('error', e);
				}
			},
			
			unanswered: resp => {
				return _.difference(recipients, _.map(responsePackets, e => e.sender));
			}
		};
		
		send();
	}

	stats() {
		return {
			unanswered: _.keys(this.responseWaiters).length,
			msgCount: this.msgCount,
			lostPackets: this.lostPackets,
			id: this.id,
			busGraph: this.busGraph.json()
		};
	}

	unansweredRequests() {
		return _.keys(this.responseWaiters);
	}

	filterInput(packet, type) {
		return this.applyFilter(this.inputFilters, packet, type);
	}

	filterOutput(packet, type) {
		return this.applyFilter(this.outputFilters, packet, type);
	}

	applyFilter(filterList, packet, type) {
		for (var i = 0; i < filterList.length; ++i) {
			packet = filterList[i](packet, type);
			assert.ok(packet);
		}
		
		return packet;
	}

	addInputFilter(filter) {
		debugMisc('Add input filter', this.id);
		this.inputFilters.push(filter);
	}

	addOutputFilter(filter) {
		debugMisc('Add output filter', this.id);
		this.outputFilters.push(filter);
	}
}

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
