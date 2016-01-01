"use strict";

const promiseEvents = require('promise-events');

exports.ncall = function(fn) {
  return function() {
    const args = arguments;
    return new Promise((resolve, reject) => {
      return fn(...args, (err, ret) => {
        if (err) {
          return reject(err);
        } else {
          return resolve(ret);
        }
      });
    });
  };
};

exports.fcall = function(fn) {
  return function() {
    const args = arguments;
    return new Promise((resolve, reject) => {
      return fn(...args, (ret, err) => {
        if (err) {
          return reject(err);
        } else {
          return resolve(ret);
        }
      });
    });
  };
};

exports.delay = exports.fcall((delay, fn) => setTimeout(fn, delay));

exports.spread = function(fn) {
  return args => fn(...args);
};

class EventEmitter extends promiseEvents.EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.setResultFilter(null);
    this.promiseOnce = exports.fcall((name, listener) => this.once(name, listener));
  }
}

exports.EventEmitter = EventEmitter;
