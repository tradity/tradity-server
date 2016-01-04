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

exports.EventEmitter = promiseEvents.EventEmitter;
