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
const spawnSync = require('./cli-helpers.js').spawnSync;

const message = {
  apeWants: 'BANANA'
};

describe('sign.js and verify.js', function() {
  it('Can create and verify signed messages', function() {
    const signed = spawnSync('./sign.js', [
      JSON.stringify(message)
    ]);
    
    assert.strictEqual(signed.status, 0);
    assert.ok(signed.stdout.toString('utf8'));
    
    const verified = spawnSync('./verify.js', [
      signed.stdout
    ]);
    
    const verifiedOutput = verified.stdout.toString('utf8');
    
    assert.strictEqual(verified.status, 0);
    assert.ok(verifiedOutput);
    
    assert.deepStrictEqual(JSON.parse(verifiedOutput), message);
  });
  
  it('Fails with missing arguments', function() {
      const signed = spawnSync('./sign.js', [], { stdio: 'pipe' });
      
      assert.notStrictEqual(signed.status, 0);
  });
  
  it('Fails with missing arguments', function() {
      const signed = spawnSync('./verify.js', [], { stdio: 'pipe' });
      
      assert.notStrictEqual(signed.status, 0);
  });
});
