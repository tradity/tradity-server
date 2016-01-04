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

const ipaddr = require('ipaddr.js');
const _ = require('lodash');
const debug = require('debug')('sotrade:login-ip-check');
const promiseUtil = require('./promise-util.js');

/**
 * Login attempt rate limiter.
 * 
 * @param {object} options  A set of options:
 * @param {int} [options.flushTimeout=1000]  Time after which all entries 
 *                                           in the check table will be deleted.
 * @param {int} [options.minWait=10]  Minimum waiting time in ms
 * @param {int} [options.maxWait=8000]  Maximum waiting time in ms
 * @param {int} [options.baseWait=50]  Default (0 attempts) waiting time in ms
 * @param {int} [options.base=2]  Base to which the number of attempts is raised
 * 
 * @public
 * @constructor LoginIPCheck
 */
function LoginIPCheck(options) {
  options = options || {};
  
  this.info = {};
  this.flushTimeout = options.flushTimeout || 3600 * 1000; // 1 hour
  this.minWait      = options.minWait || 10; // 10 ms
  this.maxWait      = options.maxWait || 8000; // 8 s
  this.base         = options.base || 2;
  this.baseWait     = options.baseWait || 50;
}

/**
 * Return a string representation of all entries within the check table.
 * 
 * @function LoginIPCheck#toString
 */
LoginIPCheck.prototype.toString = function() {
  return 'LoginIPCheck: ' + JSON.stringify(_.map(this.info, _.partialRight(_.pick, 'lastTime', 'count')));
};

/**
 * Remove entries from the check table for login attempts older
 * than `flushTimeout`.
 * 
 * @function LoginIPCheck#flushInfos
 */
LoginIPCheck.prototype.flushInfos = function() {
  const now = Date.now();
  
  const deleteIndices = [];
  for (let ip in this.info) {
    if (this.info[ip].lastTime < now - this.flushTimeout) {
      deleteIndices.push(ip);
    }
  }
  
  debug('Flushing', deleteIndices.length + ' entries');
  
  for (let i = 0; i < deleteIndices.length; ++i) {
    delete this.info[deleteIndices[i]];
  }
};

/**
 * Check the current login waiting time for an IP address.
 * IPv4 addresses are checked by /24 prefix, IPv6 addresses by /64 prefix.
 * 
 * @return {object}  A Promise which will be resolved when the waiting
 *                   period has passed.
 * 
 * @function LoginIPCheck#check
 */
LoginIPCheck.prototype.check = function(ipString) {
  const ip = ipaddr.parse(ipString);
  let ipBase;
  
  if (ip.parts) { // IPv6
    ipBase = ip.parts.slice(0, 4).join('/');
  } else {
    ipBase = ip.octets.slice(0, 3).join('.');
  }
  
  this.flushInfos();
  
  const now = Date.now();
  let info = this.info[ipBase];
  
  if (!info) {
    info = this.info[ipBase] = { lastTime: now, count: 0 };
  } else {
    info.count++;
  }
  
  const dtNow = now - info.lastTime;
  const dtWanted = (Math.pow(this.base, info.count) - 1) * this.baseWait;
  
  /* clamp leftover waiting time to [minWait, maxWait] */
  let dt = dtWanted - dtNow;
  dt = Math.max(this.minWait, dt);
  dt = Math.min(this.maxWait, dt);
  
  info.lastTime = now;
  
  debug('Delaying login', ipBase, dt + ' ms');
  return info.waiter = Promise.resolve(info.waiter).then(function() {
    return promiseUtil.delay(dt);
  });
};

module.exports = LoginIPCheck;
