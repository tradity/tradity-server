"use strict";

const _ = require('lodash');
const events = require('events');
const assert = require('assert');
const util = require('util');
const bus = require('./bus.js');

class DirectTransport extends bus.Transport {
  constructor(baseEmitter, weight, isLocal) {
    super();
    assert.ok(baseEmitter);
    
    this.baseEmitter = baseEmitter;
    this.isLocal = isLocal || baseEmitter.isLocal || false;
    this.weight = weight || baseEmitter.weight || 1;
    
    this.on = this.baseEmitter.on.bind(this.baseEmitter);
    this.emit = this.baseEmitter.emit.bind(this.baseEmitter);
  }
  
  toJSON() {
    return _.omit(this, 'baseEmitter');
  }
}

exports.DirectTransport = DirectTransport;
