"use strict";

const _ = require('lodash');
const util = require('util');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const debug = require('debug')('sotrade:signedmsg');
const buscomponent = require('./stbuscomponent.js');

/**
 * Provides methods for signing and verifying messages
 * from other server or client instances.
 * This allows authorized queries to be sent securely.
 * 
 * @public
 * @module signedmsg
 */

/**
 * Main object of the {@link module:signedmsg} module
 * 
 * @public
 * @constructor module:signedmsg~SignedMessaging
 * @augments module:stbuscomponent~STBusComponent
 */
class SignedMessaging extends buscomponent.BusComponent {
  constructor() {
    super();
    
    this.privateKey = null;
    this.publicKeys = [];
    this.algorithm = 'RSA-SHA256';
  }
}

SignedMessaging.prototype.onBusConnect = function() {
  return this.getServerConfig().then(cfg => {
    return this.useConfig(cfg);
  });
};

/**
 * Sets the server configuration to use and reads in the own private key,
 * the accepted public keys and, optionally, a specified signing algorithm.
 * 
 * @function module:signedmsg~SignedMessaging#useConfig
 */
SignedMessaging.prototype.useConfig = function(cfg) {
  assert.ok(cfg.privateKey);
  this.privateKey = fs.readFileSync(cfg.privateKey, {encoding: 'utf-8'});
  this.publicKeys = cfg.publicKeys.map(pkfile => {
    return fs.readFileSync(pkfile, {encoding: 'utf-8'})
    .replace(/\n-+BEGIN PUBLIC KEY-+\n/gi, s => '\0' + s).split(/\0/).map(s => s.trim());
  }).reduce((a, b) => a.concat(b));
  this.algorithm = cfg.signatureAlgorithm || this.algorithm;
  
  debug('Loaded keys', this.publicKeys.length + ' public keys', this.algorithm);
};

/**
 * Create a signed message for verification by other instances.
 * Note that, while base64 encoding is applied, no encryption of
 * any kind is being used.
 * 
 * @param {object} msg  An arbitrary object to be signed.
 * 
 * @return {string} Returns with a string containing the object and a signature.
 * 
 * @function busreq~createSignedMessage
 */
SignedMessaging.prototype.createSignedMessage = buscomponent.provide('createSignedMessage', ['msg'], function(msg) {
  const string = new Buffer(JSON.stringify(msg)).toString('base64') + '#' + Date.now() + '#' + Math.random();
  const sign = crypto.createSign('RSA-SHA256');
  
  return new Promise((resolve, reject) => {
    assert.ok(this.privateKey);
    sign.end(string, null, () => {
      const signed = string + '~' + sign.sign(this.privateKey, 'base64');
      return resolve(signed);
    });
  });
});

/**
 * Parse and verify a signed message created by 
 * {@link busreq~createSignedMessage}
 * 
 * @param {string} msg  The signed object.
 * @param {?int} maxAge  An optional maximum age (in seconds) for considering
 *                       the message valid
 * 
 * @return {object} Returns the signed object in case the message came from
 *                  an accepted public key or <code>null</code> otherwise.
 * 
 * @function busreq~verifySignedMessage
 */
SignedMessaging.prototype.verifySignedMessage = buscomponent.provide('verifySignedMessage',
  ['msg', 'maxAge'], function(msg, maxAge) 
{
  const msg_ = msg.split('~');
  if (msg_.length != 2)
    return null;
  
  const string = msg_[0], signature = msg_[1];
  
  return new Promise((resolve, reject) => {
    const verifySingleKey = i => {
      if (i == this.publicKeys.length)
        return resolve(null); // no key matched
      
      const pubkey = this.publicKeys[i];
      const verify = crypto.createVerify('RSA-SHA256');
      
      return verify.end(string, null, () => {
        if (verify.verify(pubkey, signature, 'base64')) {
          debug('Could verify signed message using public key', i);
          
          // move current public key to first position (lru caching)
          this.publicKeys.splice(0, 0, this.publicKeys.splice(i, 1)[0]);
          
          const stringparsed = string.split('#');
          const objstring = stringparsed[0], signTime = parseInt(stringparsed[1]);
          
          if (!maxAge || Math.abs(signTime - Date.now()) < maxAge * 1000)
            return resolve(JSON.parse(new Buffer(objstring, 'base64').toString()));
          else
            debug('Message max age was exceeded');
        }
        
        verifySingleKey(i+1); // try next key
      });
    };
    
    verifySingleKey(0);
  });
});

exports.SignedMessaging = SignedMessaging;

/* small test script */
if (require.main === module) {
  const smdb = new SignedMessaging();
  smdb.privateKey = '-----BEGIN RSA PRIVATE KEY-----\n' +
  'MIIEogIBAAKCAQEA1+x4pXKTYzlg7kb6dpQ0TX8HhDF7L6G0Jg0whCy6ssCZgLKX\n' +
  'a5t/Fp0Zv1SI7DzUVswCyxHs2Yi/tBE8Vw+PAltsC127I2uabReueCaEFfOs4e+7\n' +
  'R+IRCH1sG7g+4n3MMvqmmkKOUbekggCdY0TuMSEFiGbd2PL2Pr93R3jdQ8oBOAgl\n' +
  'bUoVOk4NVDccnn9+74ZtmrtaTiJ1oHzNhfyFDNPU2u6zUIOvCF7Hc8oQjxKZk78g\n' +
  'AB2dho/TpZDDgnq5Sfn53HT0DBR6yCz7CXH5cWFjRfalhe3X/ZMsXt936Hhz2GiP\n' +
  'MIXLjRcFX1cCGpvwEDxj0dXV9X1JNyb0mYrOywIDAQABAoIBAELr75iXokamifxP\n' +
  '02DdHjjGnjXCgEOLAqKog9jzZAny16CjuXqIfyMrHcfHE4jkcYtVP6hgrd/eGkxc\n' +
  '6y6wi8pXO21qZ43a08nsBQ8IIPgMxhBglNL6pfzToqYUvKjGBHvoY6p75lA9cqc4\n' +
  'OY+C1bA0Y9qaxzduVhOsk/N66lkPuPcWEvv0BmW0DjE64CL89hpgin2Jq+VA3Bz/\n' +
  '2JEf9OBtyjsFhvk3hIcF7mhn44qmP2vvJzk795MwzeWIqcWtEZzlmzzvc3KigLQq\n' +
  'O3V50/Sb88Pf0YhXceQ9MQb2hD+xsnIVKwrPT+MaB4/YT846RI+LlqaYwD5f6N7K\n' +
  'sMrVaoECgYEA8WPJBTkEt+yXhqQWBsYT0vcRqB9UoUz3GaRitlw0BU9BCY+vrdYq\n' +
  'F2AlaNYejr1RAhxQ0ny3msQtEpJ6Mc+b/sy/a5+lEiBYmMfWKSlIZpCdqE2SVZpq\n' +
  '2Imh9wtMoXq/B0qXsO0ak1cu1Vr3XzYY1d4EqfI6GpJShz8Q9IKjB3kCgYEA5P4a\n' +
  'GJ3ZcylIk1Na14+o9fxnzd/5aHUPg4k1v25wmlqg4FtH3nlCiAwc3i7h52vMJwRN\n' +
  '5cHe/juTPQMTJla6il6wHkmVTBDDZxwhYt5ht2Wn5bkgymxBbp5m6HGgNQboFHv5\n' +
  'b9ujWKV/mKbokFvdglPkXWMx+p3ygXTDoT4Mg2MCgYB4OavINyLbfDHn9FeoHgWH\n' +
  'oFih9KDRCaVUlyQ3EWszbcrFuVPVcAJczB01vtdPXok3VOUIQOetZKHSSzQjFPTs\n' +
  'DgwUzVmI0qVtyrImpBIUS1jKl4AXtKYcnUgW5ADRuHHmbsdobl87HUQNLZZhTG9I\n' +
  'LaEDB8raqyABjm6iaWJLeQKBgE+U34zejsuu9UH+Hfv8OUQDzC+IPy1GQXX9IWi+\n' +
  'APQjuvU9w+RVUAHn88Bjmq7Kj9CfdlL65XyFR85UWztfuMSN07cy62fcC4yyAghS\n' +
  'MLOD6K21gOfYZ4UCF9GAa6UCGXXFABMXydTs70Ml/nzs8DZy4VJzPtNSQQ0sfzBy\n' +
  'V/bxAoGALBWQ/kMxBVrPjfIdKOGRWVib+RNfzrnUMqSsMZ/+0oxkHxtvkjag7X3+\n' +
  'MN71ew1GiMQnkuddriufRrZ80CelrRTuoh9ni8KlVnc5dkSMzFO3975D3qm4wai1\n' +
  'uWdMhu78NVC+gEhkw3m6cu20Xy338tYIOk9yIebz69XEu0qNN1s=\n' +
  '-----END RSA PRIVATE KEY-----';
  
  smdb.publicKeys = [
    '-----BEGIN PUBLIC KEY-----\n' +
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1+x4pXKTYzlg7kb6dpQ0\n' +
    'TX8HhDF7L6G0Jg0whCy6ssCZgLKXa5t/Fp0Zv1SI7DzUVswCyxHs2Yi/tBE8Vw+P\n' +
    'AltsC127I2uabReueCaEFfOs4e+7R+IRCH1sG7g+4n3MMvqmmkKOUbekggCdY0Tu\n' +
    'MSEFiGbd2PL2Pr93R3jdQ8oBOAglbUoVOk4NVDccnn9+74ZtmrtaTiJ1oHzNhfyF\n' +
    'DNPU2u6zUIOvCF7Hc8oQjxKZk78gAB2dho/TpZDDgnq5Sfn53HT0DBR6yCz7CXH5\n' +
    'cWFjRfalhe3X/ZMsXt936Hhz2GiPMIXLjRcFX1cCGpvwEDxj0dXV9X1JNyb0mYrO\n' +
    'ywIDAQAB\n' +
    '-----END PUBLIC KEY-----'
  ];
  
  const message = {
    apeWants: 'BANANA'
  };
  
  smdb.createSignedMessage(message).then(function(signed) {
    console.log(signed);
    return smdb.verifySignedMessage(signed, 100);
  }).then(function(message) {
    console.log('message.apeWants =', message.apeWants);
  });
}
