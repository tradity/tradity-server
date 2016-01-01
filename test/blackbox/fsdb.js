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
