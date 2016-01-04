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
const cfg = require('../../config.js').config();
const promiseUtil = require('../../lib/promise-util.js');
const readFile = promiseUtil.ncall(fs.readFile);

if (!testHelpers.testPerformance) {
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

  describe('publish', function() {
    it('Should publish files', function() {
      return readFile('res/bob.jpg').then(data => {
        return socket.emit('publish', {
          base64: true,
          content: data.toString('base64'),
          role: 'profile.image',
          mime: 'image/jpeg',
          name: 'bob.jpg'
        });
      }).then(res => {
        assert.equal(res.code, 'publish-success');
        
        return socket.once('file-publish');
      }).then(() => {
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true,
          nohistory: true
        });
      }).then(res => {
        assert.equal(res.code, 'get-user-info-success');
        assert.ok(res.result.profilepic);
        
        const externalURI = cfg.protocol + '://' + cfg.wshost + ':' + cfg.wsports[0] + res.result.profilepic;
        
        const deferred = Promise.defer();
        
        require(cfg.protocol).get(externalURI, function(res) {
          deferred.resolve(res.statusCode);
        }).on('error', function(e) {
          deferred.reject(e);
        });
        
        return deferred.promise;
      }).then(status => {
        assert.equal(status, 200);
      });
    });
  });
});
}
