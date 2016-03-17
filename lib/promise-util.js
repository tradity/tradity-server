// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const promiseEvents = require('promise-events');
const bl = require('bl');

exports.ncall = fn => {
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

exports.fcall = fn => {
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

exports.spread = fn => args => fn(...args);

exports.EventEmitter = promiseEvents.EventEmitter;

exports.bufferFromStream = input => {
  return new Promise((resolve, reject) => {
    input.pipe(bl((err, data) => {
      if (err) {
        reject(err);
      }
      
      resolve(data);
    }));
  });
};
