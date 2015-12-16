"use strict";

const assert = require('assert');
const _ = require('lodash');
const Q = require('q');

class BusComponent {
  constructor() {
    this.bus = null;
    this.componentName = null;
    this.wantsUnplug = false;
  }

  setBus(bus, componentName) {
    assert.ok(bus);
    assert.ok(!this.bus);
    
    this.bus = bus;
    this.componentName = componentName;
    this.unansweredBusRequests = 0;
    this.wantsUnplug = false;
    this.initPromise = null;
    
    this.registerProviders();
    
    return Q(this.onBusConnect());
  }

  setBusFromParent(component) {
    assert.ok(component.bus);
    
    return this.setBus(component.bus, component.componentName + '-' + (BusComponent.objCount++));
  }

  unplugBus() {
    assert.ok(this.bus);
    
    this.wantsUnplug = true;
    
    if (this.unansweredBusRequests == 0) {
      return this.unregisterProviders().then(() => {
        this.bus = null;
        this.componentName = null;
        this.initPromise = null;
      });
    }
    
    return Promise.resolve();
  }

  imprint(obj) {
    obj = _.clone(obj);
    assert.ok(!obj.senderComponentName);
    
    obj.senderComponentName = this.componentName;
    
    return obj;
  }

  requestAnswered() {
    this.unansweredBusRequests--;
    if (this.wantsUnplug)
      return this.unplugBus();
    
    return Promise.resolve();
  }
  
  request(req) { return this._request('request', req); }
  requestImmediate(req) { return this._request('requestImmediate', req); }
  requestNearest(req) { return this._request('requestNearest', req); }
  requestLocal(req) { return this._request('requestLocal', req); }
  requestGlobal(req) { return this._request('requestGlobal', req); }

  _request(requestType, req) {
    assert.ok(this.bus);
    assert.ok(req);
    
    this.unansweredBusRequests++;
    return this.bus[requestType](this.imprint(req)).then(returnValue => {
      return this.requestAnswered().then(() => returnValue);
    }, e => {
      return this.requestAnswered().then(() => { throw e; });
    });
  }

  removeListener(event, listener) {
    assert.ok(this.bus);
    return this.bus.removeListener(event, listener);
  }

  addListener(event, listener) {
    assert.ok(this.bus);
    return this.bus.addListener(event, listener);
  }

  on(event, listener) {
    assert.ok(this.bus);
    return this.bus.on(event, listener);
  }

  once(event, listener) {
    assert.ok(this.bus);
    return this.bus.once(event, listener);
  }

  emit(name, data) {
    if (!this.bus)
      throw new Error('Cannot emit event "' + name + '" without bus connection');
    return this.bus.emit(name, data);
  }

  emitImmediate(name, data) {
    if (!this.bus)
      throw new Error('Cannot emit event "' + name + '" without bus connection');
    return this.bus.emitImmediate(name, data);
  }

  emitLocal(name, data) {
    if (!this.bus)
      throw new Error('Cannot emit event "' + name + '" without bus connection');
    return this.bus.emitLocal(name, data);
  }

  emitGlobal(name, data) {
    if (!this.bus)
      throw new Error('Cannot emit event "' + name + '" without bus connection');
    return this.bus.emitGlobal(name, data);
  }

  emitError(e) {
    if (!this.bus)
      throw e;
    return this.bus.emitImmediate('error', e);
  }

  registerProviders() {
    const promises = [];
    for (let i in this) {
      if (!this[i] || !this[i].isProvider)
        continue;
      
      // create and store a bound version so it can be removed later
      if (!this[i+'-bound'])
        this[i+'-bound'] = this[i].requestCB.bind(this);
      
      const requests = Array.isArray(this[i].providedRequest) ? this[i].providedRequest : [this[i].providedRequest];
      
      promises.push(Promise.all(requests.map(r => this.addListener(r, this[i+'-bound']))));
    }
    
    return Promise.all(promises);
  }

  unregisterProviders() {
    const promises = [];
    for (let i in this) {
      if (!this[i] || !this[i].isProvider)
        continue;
      
      assert.ok(this[i+'-bound']);
      
      const requests = Array.isArray(this[i].providedRequest) ? this[i].providedRequest : [this[i].providedRequest];
      
      promises.push(Promise.all(requests.map(r => this.removeListener(r, this[i+'-bound']))));
    }
    
    return Promise.all(promises);
  }

  _init() {
    this.initPromise = null;
  }
  
  onBusConnect() {
    return Promise.resolve();
  }
}

function provide(name, args, fn, prefilter) {
  fn.isProvider = true;
  fn.providedRequest = name;
  
  fn.requestCB = function(data) {
    if (prefilter && prefilter(data))
      return;
    
    var passArgs = [];
    for (let i = 0; i < args.length; ++i)
      passArgs.push(data[args[i]]);
    
    return Promise.resolve().then(() => {
      return fn.apply(this, passArgs);
    });
  };
  
  for (let i in fn)
    if (fn.hasOwnProperty(i) && i !== 'requestCB' && typeof fn.requestCB[i] === 'undefined')
      fn.requestCB[i] = fn[i];
  
  return fn;
};

function listener(name, fn) {
  fn.isProvider = true;
  fn.providedRequest = name;
  fn.requestCB = fn;
  
  return fn;
};

function needsInit (fn) {
  return function() {
    const arguments_ = arguments;
    
    if (this.initPromise === null)
      this.initPromise = Q(this._init());
    
    return this.initPromise.then(() => {
      return fn.apply(this, arguments_);
    });
  };
};

exports.BusComponent = BusComponent;
exports.listener     = listener;
exports.provide      = provide;
exports.needsInit    = needsInit;
