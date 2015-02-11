(function () { "use strict";

var Q = require('q');

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
 * @return {object}  A Q promise for the given key
 * 
 * @function module:minicache~Cache#use
 */
Cache.prototype.use = function(key) {
	var entry = this.entries[key];
	entry.lastUsed = Date.now();
	entry.usage++;
	
	return entry.promise;
};

/**
 * Inserts a new cache entry for a given key
 * 
 * @param {string} key  A cache key
 * @param {number} validity  A ms-bases unix timestamp for expiry
 * @param {object} promise  A value of promise for the cache entry
 * 
 * @return {object}  A Q promise for the given key
 * 
 * @function module:minicache~Cache#add
 */
Cache.prototype.add = function(key, validity, promise) {
	var now = Date.now();
	
	this.entries[key] = {
		created: now,
		usage: 0,
		validityDate: now + validity,
		promise: Q(promise)
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
	var self = this;
	
	process.nextTick(function() {
		var now = Date.now();
		
		for (var key in self.entries) {
			if (now > self.entries[key].validityDate)
				delete self.entries[key];
		}
	});
};

exports.Cache = Cache;

})();
