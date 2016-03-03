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
const _ = require('lodash');

const cfg = require('./config.js').config();
const sotradeClient = require('./sotrade-client.js');

const options = process.argv.splice(2);

assert.ok(options.length > 0);

const query = {
  type: options[0],
  id: 'server-q-query'
};

for (let i = 1; i < options.length; ++i) {
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

const protocol = cfg.protocol;
const socket = new sotradeClient.SoTradeConnection({
  url: query.wsurl || (protocol + '://' +
    (query.wshost || cfg.wshoste || cfg.wshost) + ':' +
    (query.wsport || cfg.wsporte || cfg.wsports[0])),
  logDevCheck: !query['q-quiet']
});

if (query['q-timeout']) {
  setTimeout(() => {
    console.log('timeout exceeded');
    process.exit(1);
  }, query['q-timeout'] * 1000);
}

socket.once('server-config').then(function() {
  return socket.emit(query.type, query);
}).then(data => {
  if (query.resultPath) {
    const path = String(query.resultPath).split('.');
    
    console.log(_.reduce(path, _.result, data));
  }
  
  if (!query.lurk) {
    process.exit(0);
  }
}).catch(e => console.trace(e));
