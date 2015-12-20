"use strict";

const _ = require('lodash');
const util = require('util');
const assert = require('assert');
const os = require('os');
const crypto = require('crypto');
const cytoscape = require('cytoscape');
const zlib = require('zlib');
const objectHash = require('object-hash');
const promiseUtil = require('../lib/promise-util.js');

const debug = require('debug')('sotrade:bus');
const debugEvents = require('debug')('sotrade:bus:events');
const debugPackets = require('debug')('sotrade:bus:packets');
const debugNetwork = require('debug')('sotrade:bus:network');
const debugTransport = require('debug')('sotrade:bus:transport');
const debugMisc = require('debug')('sotrade:bus:misc');

const inflate = promiseUtil.ncall(zlib.inflate);
const deflate = promiseUtil.ncall(zlib.deflate);

class BusDescription {
  constructor(data) {
    data = data || {};
    this.handledEvents = new Set(data.handledEvents || []);
    this.msgCount = data.msgCount || 0;
    this.lostPackets = data.lostPackets || 0;
    this.hostname = data.hostname || os.hostname();
    this.pid = data.pid || process.pid;
    this.id = data.id || this.determineBusID();
  }
  
  determineBusID() {
    // return hostname and hash of network interfaces, process id, current time
    return this.hostname + '-' + sha256(JSON.stringify(os.networkInterfaces()) + '|' +
      this.pid + '|' + Date.now() + '|' + Math.random()).substr(0, 12);
  }
  
  toJSON() {
    return {
      id: this.id,
      handledEvents: Array.from(this.handledEvents),
      msgCount: this.msgCount,
      lostPackets: this.lostPackets,
      hostname: this.hostname,
      pid: this.pid
    }
  }
}

class BusGraph extends promiseUtil.EventEmitter {
  constructor(localNodeDesc) {
    super();
    assert.ok(localNodeDesc.id);
    
    this.c = cytoscape({
      headless: true,
      elements: [
        {
          group: 'nodes',
          data: {
            desc: localNodeDesc,
            id: localNodeDesc.id
          }
        }
      ]
    });
    
    this.removedTransports = new Set();
    this.ownNode = this.c.getElementById(localNodeDesc.id);
    assert.ok(this.ownNode);
    assert.ok(this.ownNode.isNode());
    this.updated();
    
    // cached properties
    this._dijkstra = null;
    this._localNodes = null;
  }
  
  get dijkstra() {
    if (this._dijkstra)
      return this._dijkstra;
    
    this._dijkstra = this.c.elements().dijkstra(this.ownNode, edge => edge.data().weight);
    
    assert.ok(this.dijkstra.distanceTo);
    assert.ok(this.dijkstra.pathTo);
    
    return this.dijkstra;
  }
  
  get localNodes () {
    if (this._localNodes)
      return this._localNodes;
    
    // select all nodes + local edges, take our connected component and out of these the nodes
    this._localNodes = this.c.filter('node, edge[?isLocal]')
      .connectedComponent(this.ownNode)
      .filter('node');
    
    assert.ok(this._localNodes);
    assert.ok(this._localNodes.length >= 1);
    assert.notStrictEqual(Array.from(this._localNodes).indexOf(this.ownNode), -1);
    
    debugNetwork('Checked for local nodes', this.ownNode.id, this._localNodes.length);
    
    return this.localNodes;
  }
  
  updated() {
    this.ownNode = this.c.getElementById(this.ownNode.id());
    
    assert.ok(this.ownNode);
    assert.ok(this.ownNode.isNode());
    
    // invalidate cached properties
    this._dijkstra = null;
    this._localNodes = null;
    
    return this.emit('updated');
  }
  
  // reload the graph, choosing only the current connected component
  localize() {
    const cc = this.c.elements().connectedComponent(this.ownNode);
    this.c.load(cc.map(e => e.json()));
    assert.ok(this.c.elements().length > 0);
    
    debugNetwork('Localized bus graph', this.ownNode.id());
    
    return this.updated();
  }
  
  mergeRemoteGraph(busnode, doNotLocalize) {
    const remoteBusGraph = cytoscape(busnode.graph);
    remoteBusGraph.nodes().forEach(e => {
      const desc = new BusDescription(e.data().desc);
      e.data({desc: desc});
      assert.ok(e.data().desc instanceof BusDescription);
    });
    
    if (remoteBusGraph.gHash() == this.c.gHash())
      return Promise.resolve();
    
    // remove all own edges from the remote bus graph, then take the union and
    // add our own edges later on
    remoteBusGraph.remove(remoteBusGraph.getElementById(this.ownNode.id()));
    this.c = remoteBusGraph.union(this.c);
    
    // Remove edges from the graph of which the remote node is an endpoint (but we are not)
    // and which are not present in the remote graph;
    // Work with IDs since the nodes are in different Cytoscape instances
    const rEdgesInUnion = this.ownNode.edgesWith(this.c.elements()).map(e => e.id());
    const rEdgesInRGraph = remoteBusGraph.getElementById(busnode.id).edgesWith(remoteBusGraph.elements()).map(e => e.id());
    const ownEdges = this.ownNode.edgesWith(this.c.elements()).map(e => e.id());
    let edgesToRemove = _.difference(_.difference(rEdgesInUnion, rEdgesInRGraph), ownEdges);
    
    // remove edges that have been removed locally
    // (the remote may not yet be aware of that fact)
    edgesToRemove = _.union(edgesToRemove, Array.from(this.removedTransports));
    for (let edge of edgesToRemove)
      this.c.remove(this.c.getElementById(edge));
    
    // localization can be supressed, e. g. because we just received an initial node info
    // and the edge that keeps the graph connected is yet to be added
    // (localizing refers to taking only the current connected component)
    return Promise.resolve().then(() => {
      if (!doNotLocalize)
        this.localize();
    }).then(() => {
    // fail early in case we cannot use one of our own edges as a transport
      this.ownNode.edgesWith(this.c.elements()).forEach(e => {
        assert.ok(e);
        assert.ok(e.data().emit);
      });
    
      return this.updated();
    });
  }
  
  toJSON() {
    return this.c.json();
  }
  
  getNode(id) {
    return this.c.getElementById(id);
  }
  
  getNodes(filter) {
    return this.c.nodes().filter(filter);
  }
  
  removeTransport(id) {
    this.removedTransports.add(id);
    return this.c.remove(this.c.getElementById(id));
  }
  
  addTransport(transport) {
    return this.c.add({
      group: 'edges',
      data: transport
    });
  }
  
  listAllIds() {
    return this.c.elements().map(e => e.id());
  }
  
  expandScope(scope, eventType) {
    const eventTypeFilter = (i, e) => {
      return e.isNode() && e.data().desc.handledEvents.has(eventType);
    };
    
    switch (scope) {
      case 'immediate':
        scope = !this.ownNode.data().desc.handledEvents.has(eventType) ? [] : [this.ownNode.id()];
        break;
      case 'local':
        scope = this.localNodes.filter(eventTypeFilter).map(e => e.id());
        break;
      case 'nearest':
        // take a shortcut if we provide the relevant event ourselves
        // this proably happens quite often
        if (this.ownNode.data().desc.handledEvents.has(eventType)) {
          scope = [this.ownNode.id()];
          break;
        }
        
        // determine all nodes accepting our eventType
        const possibleTargetNodes = this.getNodes(eventTypeFilter);
        
        if (possibleTargetNodes.length == 0) {
          scope = [];
          break;
        }
        
        // find nearest of these
        const nearestId = _.min(
          possibleTargetNodes,
          e => this.dijkstra.distanceTo(e)
        ).id();
        
        assert.notStrictEqual(nearestId, this.ownNode.id());
        
        scope = [nearestId];
        break;
      case 'global':
        scope = this.c.filter(eventTypeFilter).map(e => e.id());
        break;
      default:
        break;
    }
    
    assert.ok(_.isArray(scope));
    return scope;
  }
}

class BusTransport extends promiseUtil.EventEmitter {
  constructor() {
    super();
    
    this.weight = 1;
    this.isLocal = false;
    
    // properties set by bus
    this.source = null;
    this.target = null;
    this.id = null;
    this.msgCount = 0;
    
    // state properties
    this.disconnected = false;
    this.edgeId = null;
    this.bus = null;
    
    this.initedPromise = null;
  }
  
  init(bus) {
    if (this.initedPromise)
      return this.initedPromise;
    
    assert.ok(bus);
    this.bus = bus;
    this.edgeId = sha256(Math.random() + '.' + Date.now()).substr(0, 8);
    
    debugTransport('Create transport/edge', this.bus.id, this.edgeId);
    
    // Do a three-way handshake, similar to TCP
    // This has the purpose of checking connectivity
    // for both outgoing and incoming events
    return Promise.all([
      this.on('bus::handshakeSYN', data => {
        debugTransport('Transport SYN', this.bus.id, this.edgeId, data.id, data.edgeId);
        
        if (data.id == this.bus.id)
          return;
        
        if (data.edgeId < this.edgeId)
          this.edgeId = data.edgeId; // take minimum
        
        return this.emit('bus::handshakeSYNACK', {id: this.bus.id, edgeId: this.edgeId})
          .then(() => this.bus.emitBusNodeInfo([this], true));
      }),
      
      this.on('bus::handshakeSYNACK', data => {
        debugTransport('Transport SYN/ACK', this.bus.id, this.edgeId, data.id, data.edgeId);
        
        if (data.id == this.bus.id)
          return;
        
        if (data.edgeId < this.edgeId)
          this.edgeId = data.edgeId; // take minimum
        
        return this.bus.emitBusNodeInfo([this], true);
      })
    ]).then(() =>
      this.emit('bus::handshakeSYN', {id: this.bus.id, edgeId: this.edgeId})
    );
  }
  
  assertInitialState() {
    assert.ok(this instanceof BusTransport);
    assert.strictEqual(this.source, null);
    assert.strictEqual(this.target, null);
    assert.strictEqual(this.id, null);
    assert.strictEqual(this.msgCount, 0);
    assert.strictEqual(this.bus, null);
  }
  
  toJSON() {
    return {
      weight: this.weight,
      isLocal: this.isLocal,
      source: this.source,
      target: this.target,
      id: this.id,
      msgCount: this.msgCount
    }
  }
}

class Bus extends promiseUtil.EventEmitter {
  constructor() {
    super();
    
    this.desc = new BusDescription();
    
    debug('Creating bus', this.id);
    
    this.curId = 0;
    this.busGraph = new BusGraph(this.desc);
    
    this.setMaxListeners(0);
    this.responseWaiters = new Map();
    
    this.busNodeInfoEmittingPromise = null;
    
    this.transports = new Set();
    
    this.remotesWithOurBusNodeInfo = new Set([this.id]);
    
    this.inputFilters = [];
    this.outputFilters = [];
    
    this.initedPromise = null;
  }
  
  init() {
    if (this.initedPromise)
      return this.initedPromise;
    
    return this.initedPromise = Promise.all([
      this.on('newListener', this.newListener),
      this.on('removeListener', this.removeListener)
    ]).then(() => Promise.all([
      this.on('bus::nodeInfo', this.nodeInfoHandler),
      this.busGraph.on('updated', () => {
        // inform response waiters that nodes may have been removed and are therefore not able to answer requests
        for (let w of this.responseWaiters.values()) {
          if (w.handleResponse)
            w.handleResponse(null);
        }
      })
    ])).then(() => {
      assert.ok(this.handledEvents.has('bus::nodeInfo'));
      
      debug('Created bus', this.id);
      return this;
    });
  }

  newListener(event) {
    debugEvents('Add new listener', this.id, event);
    
    if (!this.handledEvents.has(event)) {
      this.handledEvents.add(event);
      
      return this.emitBusNodeInfoSoon();
    }
  }
  
  removeListener(event) {
    debugEvents('Remove listener', this.id, event);
    if (this.listeners(event).length == 0) {
      this.handledEvents.delete(event);
      
      return this.emitBusNodeInfoSoon();
    }
  }
  
  nodeInfoHandler(data) {
    debugNetwork('Received nodeInfo', this.id);
    if (!Buffer.isBuffer(data))
      data = new Buffer(data);
    
    return inflate(data).then((data) => {
      try {
        data = JSON.parse(data);
      } catch (e) {
        throw new Error('Error parsing JSON data: ' + data + ', message = ' + e.message);
      }
      
      assert.ok(data.id && _.isString(data.id));
      assert.ok(data.graph);
      assert.ok(data.handledEvents && _.isArray(data.handledEvents));
      
      if (data.id == this.id)
        return;
      
      debugNetwork('Parsed nodeInfo', this.id + ' <- ' + data.id);
      
      return this.handleTransportNodeInfo(data, false).then(() => {
        if (this.remotesWithOurBusNodeInfo.has(data.id))
          return;
        
        this.remotesWithOurBusNodeInfo.add(data.id);
        return this.emitBusNodeInfoSoon();
      });
    });
  }
  
  get id() {
    return this.desc.id;
  }
  
  get handledEvents() {
    return this.desc.handledEvents;
  }
  
  toJSON() {
    return {
      id: this.id,
      handledEvents: Array.from(this.handledEvents),
      msgCount: this.msgCount,
      lostPackets: this.lostPackets,
      hostname: this.hostname,
      pid: this.pid
    };
  }
  
  emitBusNodeInfoSoon() {
    if (this.busNodeInfoEmittingPromise)
      return this.busNodeInfoEmittingPromise;
    
    debugNetwork('emitBusNodeInfoSoon', this.id);
    
    return this.busNodeInfoEmittingPromise =
      Promise.resolve().then(() => {
      this.busNodeInfoEmittingPromise = null;
      
      return this.emitBusNodeInfo();
    });
  }

  emitBusNodeInfo(transports, initial) {
    const info = _.extend({}, this.toJSON(), { graph: this.busGraph.toJSON() });
    
    debugNetwork('emitBusNodeInfo', this.id,
      'with transports ' + (transports || []).map(t => t.id).join(' '),
      initial ? 'initial' : 'non-initial');

    return deflate(JSON.stringify(info)).then(encodedInfo => {
      // note that initial infos are transport events, whereas
      // non-initial infos are bus events (and therefore bus packets)
      if (initial) {
        transports = transports || this.transports;
        
        // Array comprehensions would be better here
        return Promise.all(Array.from(transports).map(
          t => t.emit('bus::nodeInfoInitial', encodedInfo)
        ));
      } else {
        return this.emitGlobal('bus::nodeInfo', encodedInfo);
      }
    });
  }

  addTransport(transport) {
    transport.assertInitialState();
    
    return transport.init(this).then(() => Promise.all([
      transport.on('bus::nodeInfoInitial', data => { // ~ ACK after SYN-ACK
        if (!Buffer.isBuffer(data))
          data = new Buffer(data);
        
        return inflate(data).then(data => {
          data = JSON.parse(data);
          assert.ok(data.id);
          if (data.id == this.id)
            return null;
          
          debugTransport('Received initial bus node info', this.id, transport.edgeId, data.id);
          
          return this.handleTransportNodeInfo(data, true) // modifies busGraph property!
          .then(() => data.id)
          .then(remoteNodeID => {
            const nodeIDs = [remoteNodeID, this.id].sort(); // sort for normalization across nodes
            const transportGraphID = nodeIDs.join('-') + '-' + transport.edgeId;
            
            assert.ok(this.busGraph.getNode(nodeIDs[0]).isNode());
            assert.ok(this.busGraph.getNode(nodeIDs[1]).isNode());
            
            // remove the edge, if present, since it may have been updated
            // during reading the remote node info
            // (in which case emit() & co are missing!)
            this.busGraph.removeTransport(transportGraphID);
            
            transport.source = nodeIDs[0];
            transport.target = nodeIDs[1];
            transport.id = transportGraphID;
            transport.msgCount = 0;
            
            this.busGraph.addTransport(transport);
            
            return this.busGraph.updated();
          }).then(() => {
            this.transports.add(transport);
            
            this.emitBusNodeInfoSoon();
            
            debugTransport('Handled initial bus node info', this.id, transport.edgeId);
          });
        });
      }),
      
      transport.on('bus::packet', (p) => {
        const hasAlreadySeen = p.seenBy.indexOf(this.id) != -1;
        
        debugTransport('Received bus packet', this.id, transport.edgeId, hasAlreadySeen);
        
        if (hasAlreadySeen)
          return;
        
        transport.msgCount++;
        
        return this.handleBusPacket(p);
      }),
      
      transport.on('disconnect', () => {
        debugTransport('Received transport disconnect', this.id, transport.edgeId);
        
        this.busGraph.removeTransport(transport.id);
        this.transports.delete(transport);
        this.busGraph.localize();
        return this.busGraph.updated().then(() => {
          debugTransport('Handled transport disconnect', this.id, transport.edgeId);
        });
      })
    ]));
  }

  handleTransportNodeInfo(busnode, doNotLocalize) {
    debugNetwork('Handling transport node info', this.id, busnode.id, doNotLocalize);
    
    return this.busGraph.mergeRemoteGraph(busnode, doNotLocalize).then(() => {
      debugNetwork('Handled transport node info', this.id, busnode.id, doNotLocalize);
    });
  }

  handleBusPacket(packet) {
    assert.ok(this.initedPromise);
    
    this.msgCount++;
    
    assert.ok(this.id);
    assert.equal(packet.seenBy.indexOf(this.id), -1);
    packet.seenBy.push(this.id);
    
    assert.ok(packet.recipients.length > 0);
    
    const nextTransports = {};
    let packetIsForThis = false;
    
    return Promise.all(packet.recipients.map(recpId => {
      assert.ok(recpId);
      assert.ok(_.isString(recpId));
      assert.ok(packet.seenBy.length > 0);
      
      if (recpId == this.id) {
        // defer handling, since we might be receiving a message which invalidates the bus graph
        packetIsForThis = true;
        return;
      }
      
      const targetNode = this.busGraph.getNode(recpId);
      
      if (!targetNode || !targetNode.isNode()) {
        this.lostPackets++;
        return;
      }
      
      const path = this.busGraph.dijkstra.pathTo(targetNode);
      debugPackets('Path to recipient', this.id, recpId, packet.name, path && path.length);
      
      // path.length >= 3: at least source node, edge, target node
      if (!path || path.length < 3) {
        return (() => { // use closure so packet_ gets captured per closure
          /* no route -> probably not fully connected yet;
           * keep packet for a while */
          const packet_ = _.clone(packet);
          
          packet_.recipients = [recpId];
          packet_.seenBy = packet_.seenBy.slice(0, packet_.seenBy.length - 1);
          
          debugPackets('Re-queueing packet', this.id, recpId, packet.name);
          assert.equal(packet_.seenBy.indexOf(this.id), -1);
          
          return promiseUtil.fcall(this.busGraph.once, 'updated').then(() => {
            return this.handleBusPacket(packet_);
          });
        })();
      }
      
      // add recipient id to recipient list for this transport
      const nextTransport = path[1].data();
      assert.ok(nextTransport);
      assert.ok(nextTransport.emit);
      
      if (nextTransports[nextTransport.id])
        nextTransports[nextTransport.id].recipients.push(recpId);
      else
        nextTransports[nextTransport.id] = {transport: nextTransport, recipients: [recpId]};
    })).then(() => Promise.all(Object.keys(nextTransports).map(i => {
      const transport = nextTransports[i].transport;
      const packet_ = _.clone(packet);
      packet_.recipients = nextTransports[i].recipients;

      debugPackets('Writing packet', this.id, packet_.name, transport.id);
      transport.msgCount++;
      return transport.emit('bus::packet', packet_);
    }))).then(() => {
      if (packetIsForThis)
        return this.handleIncomingPacket(packet);
    });
  }

  handleIncomingPacket(packet) {
    packet = this.filterInput(packet, packet.name);
    
    switch (packet.type) {
      case 'event':
        return this.handleIncomingEvent(packet);
      case 'request':
        return this.handleIncomingRequest(packet);
      case 'response':
        return this.handleIncomingResponse(packet);
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
    assert.ok(this.responseWaiters.get(resp.responseTo));
    
    return this.responseWaiters.get(resp.responseTo).handleResponse(resp);
  }

  handleIncomingRequest(req) {
    debugPackets('Handle incoming request', this.id, req.name, req.requestId);
    
    assert.ok(req.name);
    assert.ok(req.data);
    assert.ok(req.requestId);
    
    req.data = _.clone(req.data);
    
    return super.emit(req.name, req.data, 'request').then(
      successes => ({ state: 'success', result: successes }),
      failure => ({ state: 'failure', result: failure })
    ).then(taggedResult => {
      debug('Handled incoming request', this.id, req.name, req.requestId,
        taggedResult.state, taggedResult.result && taggedResult.result.length);
      
      return this.handleBusPacket(this.filterOutput({
        sender: this.id,
        seenBy: [],
        recipients: [req.sender],
        state: taggedResult.state,
        result: taggedResult.result,
        responseTo: req.requestId,
        type: 'response'
      }, 'response'));
    });
  }

  listAllIds() {
    return this.busGraph.listAllIds();
  }

  emit(name, data) {
    // do not propagate events provided by EventEmitter
    if (name == 'newListener' || name == 'removeListener')
      return super.emit(name, data);
    else
      return this.emitGlobal(name, data);
  }

  emitGlobal(name, data) {
    return this.emitScoped(name, data, 'global');
  }

  emitLocal(name, data) {
    return this.emitScoped(name, data, 'local');
  }

  emitImmediate(name, data) {
    return this.emitScoped(name, data, 'immediate');
  }

  emitScoped(name, data, scope) {
    debugEvents('Emit scoped', this.id, name, scope);
    
    const recipients = this.busGraph.expandScope(scope, name);
    
    const packet = this.filterOutput({
      sender: this.id,
      seenBy: [],
      name: name,
      data: data,
      recipients: recipients,
      type: 'event'
    }, 'event');
    
    if (recipients.length != 0)
      return this.handleBusPacket(packet);
  }

  request(req) {
    return this.requestNearest(req);
  }
  
  requestNearest(req) {
    return this.requestScoped(req, 'nearest');
  }

  requestImmediate(req) {
    return this.requestScoped(req, 'immediate');
  }

  requestLocal(req) {
    return this.requestScoped(req, 'local');
  }

  requestGlobal(req) {
    return this.requestScoped(req, 'global');
  }

  requestScoped(req, scope) {
    assert.ok(req);
    
    req = _.clone(req);
    assert.ok(req.name);
    assert.ok(!req.reply);
    
    const requestId = this.id + '-' + (this.curId++);
    const recipients = this.busGraph.expandScope(scope, req.name);
    
    debugEvents('Request scoped', this.id, req.name, requestId, scope, recipients.length);
    
    // scope is now array of target ids
    assert.ok(_.isArray(recipients));
    assert.ok(_.difference(recipients, this.listAllIds()).length == 0);
    
    if (recipients.length == 0) {
      const e = new Error('Nonexistent event/request type: ' + req.name);
      e.nonexistentType = true;
      return Promise.reject(e);
    }
    
    const deferred = Promise.defer();
    const responsePackets = [];
    
    this.responseWaiters.set(requestId, {
      handleResponse: responsePacket => {
        const availableRecipients = _.intersection(this.listAllIds(), recipients);
        
        debugEvents('Response packet in', this.id, scope, requestId,
          responsePackets.length, availableRecipients.length,
          recipients.length, responsePacket && responsePacket.state);
        
        if (responsePacket !== null) {
          assert.ok(responsePacket.sender);
          
          if (responsePacket.state === 'failure')
            return deferred.reject(responsePacket.result);
          
          responsePackets.push(responsePacket);
          
          assert.strictEqual(responsePacket.state, 'success');
        }
        
        // all responses in?
        if (responsePackets.length != availableRecipients.length) 
          return; // wait until they are
        
        this.responseWaiters.delete(requestId);
        
        if (scope == 'nearest') {
          // re-send in case the packet got lost (disconnect or similar)
          if (responsePackets.length == 0 ||
              responsePackets[0].result.length == 0) {
              debugEvents('Re-sending request due to missing answer', this.id, req.name, requestId, scope, recipients);
            return this.requestScoped(req, scope);
          }
          
          assert.equal(responsePackets.length, 1);
          assert.equal(responsePackets[0].result.length, 1);
          
          return deferred.resolve(responsePackets[0].result[0]);
        } else {
          return deferred.resolve(_.pluck(responsePackets, 'result'));
        }
      },
      
      unanswered: resp => {
        return _.difference(recipients, _.map(responsePackets, e => e.sender));
      }
    });
    
    return this.handleBusPacket(this.filterOutput({
      sender: this.id,
      seenBy: [],
      name: req.name,
      data: req,
      requestId: requestId,
      recipients: recipients,
      type: 'request',
      singleResponse: scope == 'nearest'
    }, 'request')).then(() => deferred.promise);
  }

  stats() {
    return {
      unanswered: this.unansweredRequests.length,
      msgCount: this.msgCount,
      lostPackets: this.lostPackets,
      id: this.id,
      busGraph: this.busGraph.toJSON()
    };
  }

  get unansweredRequests() {
    return Array.from(this.responseWaiters.keys());
  }

  filterInput(packet, type) {
    return this.applyFilter(this.inputFilters, packet, type);
  }

  filterOutput(packet, type) {
    return this.applyFilter(this.outputFilters, packet, type);
  }

  applyFilter(filterList, packet, type) {
    for (let i = 0; i < filterList.length; ++i) {
      packet = filterList[i](packet, type);
      assert.ok(packet);
    }
    
    return packet;
  }

  addInputFilter(filter) {
    debugMisc('Add input filter', this.id);
    assert.ok(this.initedPromise);
    return this.inputFilters.push(filter);
  }

  addOutputFilter(filter) {
    debugMisc('Add output filter', this.id);
    assert.ok(this.initedPromise);
    return this.outputFilters.push(filter);
  }
}

exports.Bus = Bus;
exports.Graph = BusGraph;
exports.Transport = BusTransport;

/* cytoscape connected component extension */
cytoscape('collection', 'connectedComponent', function(root) {
  return this.breadthFirstSearch(root).path.closedNeighborhood();
});

/* cytoscape graph hashing extension */
cytoscape('core', 'gHash', function() {
  const nodes = this.nodes();
  const nodeData = {};
  
  nodes.forEach(v => {
    nodeData[v.id()] = [
      v.data().desc.handledEvents,
      v.edgesWith(nodes).map(e => e.id()).sort()
    ];
  });
  
  return objectHash(nodeData);
});

/* cytoscape graph union extension */
cytoscape('core', 'union', function(g2) {
  const g1 = this;
  
  const elements = [];
  const j1 = g1.json();
  const j2 = g2.json();
  
  const ids = {};
  const lists = [j1.elements.nodes, j2.elements.nodes, j1.elements.edges, j2.elements.edges];
  
  for (let i = 0; i < lists.length; ++i) {
    if (!lists[i])
      continue;
    
    for (let j = 0; j < lists[i].length; ++j) {
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
  const h = crypto.createHash('sha256');
  h.end(s);
  return h.read().toString('hex');
}
