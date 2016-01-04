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

const crypto = require('crypto');

/**
 * Returns the SHA256 hash of a string.
 * 
 * @param {string} s  The input string.
 * 
 * @function sha256
 * @return {string}  The hexadecimal hashed value.
 */
function sha256 (s) {
  const h = crypto.createHash('sha256');
  h.end(s);
  return h.read().toString('hex');
}

module.exports = sha256;
