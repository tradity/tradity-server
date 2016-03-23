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

require('../common.js');
const child_process = require('child_process');
const path = require('path');

const spawnDefaultOpt = {
  cwd: path.resolve(__dirname, '../../'),
  stdio: ['ignore', 'pipe', 'inherit']
};

exports.spawnSync = (spawn, args, opt) => {
  const child = child_process.spawnSync(spawn, args,
    Object.assign({}, spawnDefaultOpt, opt));
  
  if (child.error) {
    throw child.error;
  }
  
  return child;
};
