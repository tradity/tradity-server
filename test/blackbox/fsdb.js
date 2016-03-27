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
const fs = require('fs');
const testHelpers = require('./test-helpers.js');
const Config = require('../../config.js');
const cfg = new Config().reloadConfig().config();
const promiseUtil = require('../../lib/promise-util.js');
const readFile = promiseUtil.ncall(fs.readFile);
const request = require('request');
const nock = require('nock');

describe('fsdb', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  const externalURIBase = cfg.protocol + '://' + cfg.wshost + ':' + cfg.wsports[0];
  const fakeContent = new Buffer('Hello, World! 你好!');
  const fakeContentType = 'text/x-hello-world;charset=utf-8';
  
  describe('/dynamic/files', function() {
    
    before(function() {
      nock('https://example.com')
        .persist()
        .get(/\/fake-profile-pic$/)
        .reply(200, fakeContent, {
          'Content-Type': fakeContentType,
          'X-Ignored-Header': 'meow'
        });
    });
    
    it('Should publish files', function() {
      return readFile('res/bob.jpg').then(data => {
        return Promise.all([
          socket.post('/dynamic/files', {
            json: false,
            body: data,
            headers: {
              'Content-Type': 'image/jpeg'
            },
            qs: {
              role: 'profile.image',
              name: 'bob.jpg'
            }
          }).then(res => {
            assert.ok(res._success);
          }),
          socket.once('feed-file-publish')
        ]);
      }).then(() => {
        return socket.get('/user/$self', {
          cache: false, __sign__: true,
          qs: { nohistory: true }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.profilepic);
        
        const externalURI = externalURIBase + res.data.profilepic;
        
        return new Promise((resolve, reject) => {
          request(externalURI, (err, res/*, body*/) => {
            if (err) {
              reject(err);
            }
            
            resolve(res.statusCode);
          });
        });
      }).then(status => {
        assert.strictEqual(status, 200);
      });
    });
    
    it('Can create proxied URLs', function() {
      return socket.post('/dynamic/files', {
        json: false,
        body: 'https://example.com/fake-profile-pic',
        headers: {
          'Content-Type': 'text/plain'
        },
        qs: {
          role: 'profile.image',
          proxy: true
        },
        __sign__: true
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.filename);
        
        const externalURI = externalURIBase + '/dynamic/files/' + res.filename;
        
        return new Promise((resolve, reject) => {
          request(externalURI, (err, res) => {
            if (err) {
              reject(err);
            }
            
            resolve(res);
          });
        });
      }).then(proxiedResponse => {
        assert.strictEqual(proxiedResponse.statusCode, 200);
        assert.deepStrictEqual(new Buffer(proxiedResponse.body), fakeContent);
        assert.strictEqual(proxiedResponse.headers['content-type'], fakeContentType);
        assert.strictEqual(proxiedResponse.headers['x-ignored-header'], undefined);
      });
    });
  });
  
  describe('/dynamic/files/:filename', function() {
    it('Should return 404 for non-existent files', function() {
      const externalURI = externalURIBase + '/dynamic/files/nonexistent';
      
      return new Promise((resolve, reject) => {
        request(externalURI, (err, res) => {
            if (err) {
              reject(err);
            }
            
            resolve(res.statusCode);
          });
        }).then(status => {
          assert.strictEqual(status, 404);
        });
    });
  });
});
