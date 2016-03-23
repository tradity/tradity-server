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

'use strict';

const assert = require('assert');

const SignedMessaging = require('../../signedmsg.js').SignedMessaging;

const privateKey = '-----BEGIN RSA PRIVATE KEY-----\n' +
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

const publicKey = '-----BEGIN PUBLIC KEY-----\n' +
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1+x4pXKTYzlg7kb6dpQ0\n' +
    'TX8HhDF7L6G0Jg0whCy6ssCZgLKXa5t/Fp0Zv1SI7DzUVswCyxHs2Yi/tBE8Vw+P\n' +
    'AltsC127I2uabReueCaEFfOs4e+7R+IRCH1sG7g+4n3MMvqmmkKOUbekggCdY0Tu\n' +
    'MSEFiGbd2PL2Pr93R3jdQ8oBOAglbUoVOk4NVDccnn9+74ZtmrtaTiJ1oHzNhfyF\n' +
    'DNPU2u6zUIOvCF7Hc8oQjxKZk78gAB2dho/TpZDDgnq5Sfn53HT0DBR6yCz7CXH5\n' +
    'cWFjRfalhe3X/ZMsXt936Hhz2GiPMIXLjRcFX1cCGpvwEDxj0dXV9X1JNyb0mYrO\n' +
    'ywIDAQAB\n' +
    '-----END PUBLIC KEY-----';

const message = {
  apeWants: 'BANANA'
};

describe('SignedMessaging', function() {
  it('Can create and verify signed messages', function() {
    const smdb = new SignedMessaging();
    smdb.privateKey = privateKey;
    
    smdb.publicKeys = [ publicKey ];
    
    return smdb.createSignedMessage(message).then(signed => {
      const decoded = new Buffer(signed.split(/#/)[0], 'base64').toString('utf8');
      const signedObject = JSON.parse(decoded);
      assert.deepStrictEqual(signedObject, message);
      
      return smdb.verifySignedMessage(signed, 100);
    }).then(vMessage => {
      assert.deepStrictEqual(message, vMessage);
    });
  });
  
  it('Will refuse to verify a message signed with an invalid public key', function() {
    const smdb = new SignedMessaging();
    smdb.privateKey = privateKey;
    
    smdb.publicKeys = [ publicKey.replace(/A/g, 'B') ];
    
    return smdb.createSignedMessage(message).then(signed => {
      return smdb.verifySignedMessage(signed, 100);
    }).catch(() => null).then(vMessage => {
      assert.strictEqual(null, vMessage);
    });
  });
  
  it('Will refuse to verify a message signed with an invalid private key', function() {
    const smdb = new SignedMessaging();
    smdb.privateKey = privateKey.replace(/A/g, 'B');
    
    smdb.publicKeys = [ publicKey ];
    
    return smdb.createSignedMessage(message).then(signed => {
      return smdb.verifySignedMessage(signed, 100);
    }).catch(() => null).then(vMessage => {
      assert.strictEqual(null, vMessage);
    });
  });
  
  it('Will refuse to verify a message signed with invalid content', function() {
    const smdb = new SignedMessaging();
    smdb.privateKey = privateKey;
    
    smdb.publicKeys = [ publicKey ];
    
    return smdb.createSignedMessage(message).then(signed => {
      signed = '0' + signed.substr(1);
      
      return smdb.verifySignedMessage(signed, 100);
    }).then(vMessage => {
      assert.strictEqual(null, vMessage);
    });
  });
});
