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
};

module.exports = sha256;
