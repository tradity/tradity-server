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

const _ = require('lodash');

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
 * @function deepupdate
 * @return {object} A modified version of the original object.
 */
function deepupdate (orig, u /*, ... */) {
  if (!orig || !u) {
    return orig;
  }
  
  Object.keys(u).forEach(k => {
    if (_.isObject(u[k]) && _.isObject(orig[k]) && !_.isArray(u[k])) {
      orig[k] = deepupdate(orig[k], u[k]);
    } else {
      orig[k] = u[k];
    }
  });
  
  const args = Array.prototype.slice.call(arguments);
  args.splice(1, 1); // remove u
  return deepupdate.apply(null, args);
}

module.exports = deepupdate;
