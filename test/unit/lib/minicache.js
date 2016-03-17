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

const Cache = require('../../../lib/minicache.js').Cache;

describe('Cache', function() {
  it('Can cache data for a bit of time', function() {
    const cache = new Cache();
    cache.add('key1', 20, 'forty-two');
    cache.add('key2', 20, 'forty-three');
    
    assert.ok( cache.has('key1'));
    assert.ok( cache.has('key2'));
    assert.ok(!cache.has('key3'));
    
    return cache.use('key1').then(v => {
      assert.strictEqual(v, 'forty-two');
    });
  });
  
  it('Can flush outdated keys', function() {
    const cache = new Cache();
    cache.add('key1', -1, 'forty-two');
    
    assert.ok(!cache.has('key1'));
  });
});
