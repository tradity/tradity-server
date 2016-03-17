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
const stream = require('stream');

const promiseUtil = require('../../../lib/promise-util.js');

describe('fcall', function() {
  it('Turns a callback-based function in to a promise-based one', function() {
    const fn = promiseUtil.fcall(cb => cb(14));
    
    return fn().then(result => {
      assert.strictEqual(result, 14);
    });
  });
  
  it('Forwards arguments', function() {
    const fn = promiseUtil.fcall((a, b, cb) => cb(a + b));
    
    return fn(9, 16).then(result => {
      assert.strictEqual(result, 25);
    });
  });
  
  it('Forwards errors', function() {
    const fn = promiseUtil.fcall(cb => cb(null, new Error()));
    
    return fn().then((/*result*/) => {
      assert.ok(false);
    }, err => {
      assert.ok(err);
      return;
    });
  });
});

describe('ncall', function() {
  it('Turns a callback-based function in to a promise-based one', function() {
    const fn = promiseUtil.ncall(cb => cb(null, 14));
    
    return fn().then(result => {
      assert.strictEqual(result, 14);
    });
  });
  
  it('Forwards arguments', function() {
    const fn = promiseUtil.ncall((a, b, cb) => cb(null, a + b));
    
    return fn(9, 16).then(result => {
      assert.strictEqual(result, 25);
    });
  });
  
  it('Forwards errors', function() {
    const fn = promiseUtil.ncall(cb => cb(new Error(), null));
    
    return fn().then((/*result*/) => {
      assert.ok(false);
    }, err => {
      assert.ok(err);
    });
  });
});

describe('bufferFromStream', function() {
  it('Turns a stream into a promise for a Buffer', function() {
    const pt = new stream.PassThrough();
    
    return Promise.all([
      pt.end('Banana', 'utf-8'),
      promiseUtil.bufferFromStream(pt).then(data => {
        assert.ok(Buffer.isBuffer(data));
        assert.strictEqual(data.toString('utf8'), 'Banana');
      })
    ]);
  });
  
  it('Forwards errors', function() {
    const pt = new stream.PassThrough();
    
    return Promise.all([
      promiseUtil.bufferFromStream(pt).then((/*data*/) => {
        assert.ok(false);
      }, err => {
        assert.ok(err);
      }),
      pt.emit('error', new Error('Synthetic error'))
    ]);
  });
});
