'use strict';

const assert = require('assert');
const _ = require('lodash');
const testHelpers = require('./test-helpers.js');
const promiseUtil = require('../../lib/promise-util.js');
const spread = promiseUtil.spread;

describe('user', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('get-user-info', function() {
    it('Should return no values with .nohistory', function() {
      return socket.emit('get-user-info', {
        lookfor: user.name,
        nohistory: true,
        noCache: true, __sign__: true
      }).then(res => {
        assert.equal(res.code, 'get-user-info-success');
        assert.ok(res.result);
        assert.ok(!res.comments);
        assert.ok(!res.orders);
        assert.ok(!res.values);
      });
    });
    
    it('Should return a valuehistory without .nohistory', function() {
      return socket.emit('prod', {
        __sign__: true
      }).then(() => {
        return socket.emit('get-user-info', {
          lookfor: user.name,
          noCache: true, __sign__: true
        });
      }).then(res => {
        assert.equal(res.code, 'get-user-info-success');
        assert.ok(res.result);
        assert.ok(res.pinboard);
        assert.ok(res.orders);
        assert.ok(res.values);
      });
    });
    
    it('Should be able to search by name and by ID', function() {
      return Promise.all([socket.emit('get-user-info', {
        lookfor: user.name,
        nohistory: true,
        noCache: true, __sign__: true
      }), socket.emit('get-user-info', {
        lookfor: user.uid,
        nohistory: true,
        noCache: true, __sign__: true
      })]).then(spread((byName, byID) => {
        assert.equal(byName.code, 'get-user-info-success');
        assert.equal(byID.code, 'get-user-info-success');
        assert.equal(byName.result.name, byID.result.name);
        assert.equal(byName.result.totalvalue, byID.result.totalvalue);
        assert.equal(byName.result.lstockid, byID.result.lstockid);
      }));
    });
  });
  
  describe('get-ranking', function() {
    it('Should return a list of all users', function() {
      return socket.emit('get-ranking').then(res => {
        assert.equal(res.code, 'get-ranking-success');
        assert.ok(res.result);
        assert.ok(res.result.length > 0);
        assert.ok(res.result[0].name);
        assert.ok(res.result[0].totalvalue);
      });
    });
  });
  
  describe('validate-username', function() {
    it('Should allow valid user names', function() {
      return socket.emit('validate-username', {
        name: 'Banana1992'
      }).then(res => {
        assert.equal(res.code, 'validate-username-valid');
      });
    });
    
    it('Should recognize invalid user names', function() {
      return socket.emit('validate-username', {
        name: 'Banana 1992'
      }).then(res => {
        assert.equal(res.code, 'reg-name-invalid-char');
      });
    });
    
    it('Should recognize already present user names', function() {
      return socket.emit('validate-username', {
        name: user.name
      }).then(res => {
        assert.equal(res.code, 'reg-name-already-present');
      });
    });
  });
  
  describe('validate-email', function() {
    it('Should allow valid email addresses', function() {
      return socket.emit('validate-email', {
        email: 'Banana1992@notsohotmail.com'
      }).then(res => {
        assert.equal(res.code, 'validate-email-valid');
      });
    });
    
    it('Should recognize invalid email addresses', function() {
      return socket.emit('validate-email', {
        email: 'Banana 1992'
      }).then(res => {
        assert.equal(res.code, 'reg-invalid-email');
      });
    });
    
    it('Should recognize already present email addresses', function() {
      return socket.emit('validate-email', {
        email: user.email
      }).then(res => {
        assert.equal(res.code, 'reg-email-already-present');
      });
    });
  });
});
