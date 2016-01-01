"use strict";

const _ = require('lodash');
const assert = require('assert');
const bus = require('./bus.js');

class ProcessTransport extends bus.Transport {
  constructor(processObject, weight) {
    super();
    assert.ok(processObject);
    
    this.processObject = processObject;
    this.isLocal = true;
    this.weight = weight || 1;
  }
  
  init(bus) {
    return super.init(bus).then(() => Promise.all([
      this.processObject.on('message', msg => {
        if (msg.type !== 'tmsg') {
          return;
        }
        
        return super.emit(msg.name, msg.data);
      }),
      
      this.processObject.on('disconnect', () => {
        return super.emit('disconnect');
      })
    ]));
  }
  
  toJSON() {
    return _.omit(this, 'processObject');
  }

  emit(name, data) {
    this.processObject.send({type: 'tmsg', name: name, data: data});
    
    return super.emit(name, data);
  }
}

exports.ProcessTransport = ProcessTransport;
