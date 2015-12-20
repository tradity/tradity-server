"use strict";

const promiseEvents = require('promise-events');

exports.ncall = function(fn) {
  return function() {
    const args = arguments;
    return new Promise((resolve, reject) => {
      return fn(...args, (err, ret) => {
        if (err)
          return reject(err);
        else
          return resolve(ret);
      });
    });
  };
}

exports.fcall = function(fn) {
  return function() {
    const args = arguments;
    return new Promise((resolve, reject) => {
      return fn(...args, (ret, err) => {
        if (err)
          return reject(err);
        else
          return resolve(ret);
      });
    });
  };
}

exports.delay = exports.fcall(setTimeout);

exports.spread = function(fn) {
  return args => fn(...args);
};

exports.EventEmitter = class EventEmitter extends promiseEvents.EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.setResultFilter(null);
  }
}
