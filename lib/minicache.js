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

/**
 * Provides the {@link module:minicache~Cache} object.
 * 
 * @public
 * @module minicache
 */

/**
 * Caches arbitrary <code>String → Object<code> mappings
 * 
 * @public
 * @constructor module:minicache~Cache
 */
function Cache() {
  this.entries = {};
}

/**
 * Returns true iff there is an cache item for a given key.
 * 
 * @param {string} key  A cache key
 * 
 * @return {boolean}  A boolean value indicating presence of the item.
 * 
 * @function module:minicache~Cache#has
 */
Cache.prototype.has = function(key) {
  return this.entries[key] != null;
};

/**
 * Returns a cache item for a given key.
 * 
 * @param {string} key  A cache key
 * 
 * @return {object}  A Promise for the given key
 * 
 * @function module:minicache~Cache#use
 */
Cache.prototype.use = function(key) {
  const entry = this.entries[key];
  entry.lastUsed = Date.now();
  entry.usage++;
  
  return entry.promise;
};

/**
 * Inserts a new cache entry for a given key
 * 
 * @param {string} key  A cache key
 * @param {number} validity  A ms-bases unix timestamp for expiry
 * @param {object} promise  A value or promise for the cache entry
 * 
 * @return {object}  A Promise for the given key
 * 
 * @function module:minicache~Cache#add
 */
Cache.prototype.add = function(key, validity, promise) {
  const now = Date.now();
  
  this.entries[key] = {
    created: now,
    usage: 0,
    validityDate: now + validity,
    promise: Promise.resolve(promise)
  };
  
  this.flush();
  
  return this.use(key);
};

/**
 * Flush outdated cache entries.
 * 
 * @function module:minicache~Cache#flush
 */
Cache.prototype.flush = function() {
  process.nextTick(() => {
    const now = Date.now();
    
    for (let key in this.entries) {
      if (now > this.entries[key].validityDate) {
        delete this.entries[key];
      }
    }
  });
};

exports.Cache = Cache;
