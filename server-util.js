(function () { "use strict";

var crypto = require('crypto');
var _ = require('lodash');

/**
 * Provides various utility functions.
 * 
 * @module server-util
 */

/**
 * Returns the SHA256 hash of a string.
 * 
 * @param {string} s  The input string.
 * 
 * @function server-util~sha256
 * @return {string}  The hexadecimal hashed value.
 */
var sha256 = function (s) {
	var h = crypto.createHash('sha256');
	h.end(s);
	return h.read().toString('hex');
};

exports.sha256 = sha256;

/**
 * Performs a deep update/deep extend on an object.
 * 
 * @example
 * deepupdate({a: {b: 2, c: 8}, x: 17, y: 42}, {a: {b: 4, d: 9}, x: 82})
 * -> { a: {b: 4, c: 8, d: 9}, x: 82, y: 42}
 * 
 * @param {object} orig  The original object. It will be modified and returned.
 * @param {object} u  One or more objects that will be merged into the original one.
 *                    Multiple parameters are accepted.
 * 
 * @function server-util~deepupdate
 * @return {object} A modified version of the original object.
 */
var deepupdate = function (orig, u /*, ... */) {
	if (!orig || !u)
		return orig;
	
	_.chain(u).keys().forEach(function(k) {
		if (_.isObject(u[k]) && _.isObject(orig[k]) && !_.isArray(u[k]))
			orig[k] = deepupdate(orig[k], u[k]);
		else
			orig[k] = u[k];
	}).value();
	
	var args = Array.prototype.slice.call(arguments);
	args.splice(1, 1); // remove u
	return deepupdate.apply(this, args);
};

exports.deepupdate = deepupdate;

})();
