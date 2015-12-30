'use strict';

const assert = require('assert');
const _ = require('lodash');
const testHelpers = require('./test-helpers.js');
const promiseUtil = require('../../lib/promise-util.js');

describe('dqueries', function() {
  let socket;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('dquery', function() {
    it('Should let users delay queries', function() {
      return socket.emit('dquery', {
        condition: 'time > ' + parseInt(Date.now()/1000 + 5),
        query: { type: 'ping' }
      }).then(res => {
        assert.equal(res.code, 'dquery-success');
        
        return promiseUtil.delay(10000);
      }).then(() => {
        return Promise.all([
          socket.once('dquery-exec'),
          socket.emit('dquery-checkall', { __sign__: true })
        ]);
      });
    });
  });
  
  describe('dquery-list', function() {
    it('Should list a user’s delayed queries', function() {
      return socket.emit('dquery', {
        condition: 'time > ' + parseInt(Date.now()/1000 + 60),
        query: { type: 'ping' }
      }).then(res => {
        assert.equal(res.code, 'dquery-success');
        
        return socket.emit('dquery-list');
      }).then(res => {
        assert.equal(res.code, 'dquery-list-success');
        assert.ok(res.results);
        assert.ok(res.results.length > 0);
      });
    });
  });
  
  describe('dquery-list', function() {
    it('Should remove a delayed query', function() {
      let queryid;
      
      return socket.emit('dquery', {
        condition: 'time > ' + parseInt(Date.now()/1000 + 60),
        query: { type: 'ping' }
      }).then(res => {
        assert.equal(res.code, 'dquery-success');
        queryid = res.queryid;
        
        return socket.emit('dquery-remove', {
          queryid: queryid
        });
      }).then(res => {
        assert.equal(res.code, 'dquery-remove-success');
        
        return socket.emit('dquery-list');
      }).then(res => {
        assert.equal(res.code, 'dquery-list-success');
        assert.ok(res.results);
        assert.ok(_.pluck(res.results, 'queryid').indexOf(queryid) == -1);
      });
    });
  });
});
