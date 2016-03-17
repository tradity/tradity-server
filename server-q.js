#!/usr/bin/env node
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

"use strict";
/*jshint -W061 */

Error.stackTraceLimit = Infinity;

const assert = require('assert');

const sotradeClient = require('./sotrade-client.js');

const options = process.argv.splice(2);

assert.ok(options.length > 0);

const method = options[0];
const url = options[1];
const query = {};

for (let i = 2; i < options.length; ++i) {
  const p = options[i].match(/^-{0,2}([\w_-]+)=(.*)$/);
  
  let value = p[2];
  if (value === 'false') { value = false; }
  if (value === 'true')  { value = true; }
  if (value === 'null')  { value = null; }
  
  if (value && value.length > 0 && value[0] === '$') {
    value = eval(value.substr(1));
  }
  
  query[p[1]] = value;
}

const socket = new sotradeClient.SoTradeConnection();

if (query['q-timeout']) {
  setTimeout(() => {
    console.log('timeout exceeded');
    process.exit(1);
  }, query['q-timeout'] * 1000);
}

return socket({
  url: url,
  method: method,
  body: query
}).then(result => {
  if (query.resultPath) {
    const path = String(query.resultPath).split('.');
    
    console.log(path.reduce((obj, prop) => obj[prop], result));
  }
  
  process.exit(result._success ? 0 : 1);
}).catch(e => console.trace(e));
