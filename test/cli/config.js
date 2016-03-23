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
const path = require('path');
const fs = require('fs');
const spawnSync = require('./cli-helpers.js').spawnSync;
const Config = require('../../config.js');
const cfg = new Config().reloadConfig().config();

describe('config.js', function() {
  it('Can list the current config', function() {
    const result = spawnSync('./config.js', []);
    
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.toString().match(/defaultStartingMoney:/));
  });
  
  it('Can list all included config files', function() {
    const result = spawnSync('./config.js', ['--show-files']);
      
    assert.strictEqual(result.status, 0);
    const configFiles = result.stdout.toString().split('\n').filter(f => f);
    
    assert.ok(configFiles.length > 0);
    
    configFiles.forEach(filename => {
      // throws on failure
      fs.accessSync(path.resolve(__dirname, '../../', filename), fs.R_OK);
    });
  });
  
  it('Can extract config properties by path', function() {
    const result = spawnSync('./config.js', ['clientconfig', 3]);
    
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.toString().trim(), cfg.clientconfig[3]);
  });
});
