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

const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const debug = require('debug')('sotrade:signedmsg');
const api = require('./api.js');

class SignedMessaging extends api.Component {
  constructor() {
    super({
      identifier: 'SignedMessaging',
      description: 'Create signed messages and verify them.',
      depends: ['Config']
    });
    
    this.privateKey = null;
    this.publicKeys = [];
    this.algorithm = 'RSA-SHA256';
  }
  
  init() {
    this.useConfig(this.load('Config').config());
  }
  
  /**
   * Sets the server configuration to use and reads in the own private key,
   * the accepted public keys and, optionally, a specified signing algorithm.
   */
  useConfig(cfg) {
    assert.ok(cfg.privateKey);
    this.privateKey = fs.readFileSync(cfg.privateKey, {encoding: 'utf-8'});
    this.publicKeys = cfg.publicKeys.map(pkfile => {
      return fs.readFileSync(pkfile, {encoding: 'utf-8'})
      .replace(/\n-+BEGIN PUBLIC KEY-+\n/gi, s => '\0' + s).split(/\0/).map(s => s.trim());
    }).reduce((a, b) => a.concat(b));
    this.algorithm = cfg.signatureAlgorithm || this.algorithm;
    
    debug('Loaded keys', this.publicKeys.length + ' public keys', this.algorithm);
  }

  /**
   * Create a signed message for verification by other instances.
   * Note that, while base64 encoding is applied, no encryption of
   * any kind is being used.
   * 
   * @param {object} msg  An arbitrary object to be signed.
   * 
   * @return {string} Returns with a string containing the object and a signature.
   */
  createSignedMessage(msg) {
    const string = new Buffer(JSON.stringify(msg)).toString('base64') + '#' + Date.now() + '#' + Math.random();
    const sign = crypto.createSign('RSA-SHA256');
    
    return new Promise((resolve, reject) => {
      assert.ok(this.privateKey);
      sign.on('error', reject);
      
      sign.end(string, null, () => {
        try {
          const signed = string + '~' + sign.sign(this.privateKey, 'base64');
          return resolve(signed);
        } catch (e) {
          return reject(e);
        }
      });
    });
  }

  /**
   * Parse and verify a signed message created by 
   * {@link #createSignedMessage}
   * 
   * @param {string} msg  The signed object.
   * @param {?int} maxAge  An optional maximum age (in seconds) for considering
   *                       the message valid
   * 
   * @return {object} Returns the signed object in case the message came from
   *                  an accepted public key or <code>null</code> otherwise.
   */
  verifySignedMessage(msg, maxAge) {
    const msg_ = msg.split('~');
    if (msg_.length !== 2) {
      return null;
    }
    
    const string = msg_[0], signature = msg_[1];
    
    return new Promise((resolve, reject) => {
      const verifySingleKey = i => {
        if (i === this.publicKeys.length) {
          return resolve(null); // no key matched
        }
        
        const pubkey = this.publicKeys[i];
        const verify = crypto.createVerify('RSA-SHA256');
        verify.on('error', reject);
        
        return verify.end(string, null, () => {
          let isVerified = false;
          
          try {
            isVerified = verify.verify(pubkey, signature, 'base64');
          } catch (e) {
            return reject(e);
          }
          
          if (isVerified) {
            debug('Could verify signed message using public key', i);
            
            // move current public key to first position (lru caching)
            this.publicKeys.splice(0, 0, this.publicKeys.splice(i, 1)[0]);
            
            const stringparsed = string.split('#');
            const objstring = stringparsed[0], signTime = parseInt(stringparsed[1]);
            
            if (!maxAge || Math.abs(signTime - Date.now()) < maxAge * 1000) {
              return resolve(JSON.parse(new Buffer(objstring, 'base64').toString()));
            } else {
              debug('Message max age was exceeded');
            }
          }
          
          verifySingleKey(i+1); // try next key
        });
      };
      
      verifySingleKey(0);
    });
  }
}

exports.SignedMessaging = SignedMessaging;
exports.components = [
  SignedMessaging
];
