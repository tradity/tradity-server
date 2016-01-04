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
const bus = require('../../bus/bus.js');
const buscomponent = require('../../stbuscomponent.js');
const cfg = require('../../config.js').config();
const _ = require('lodash');
const util = require('util');

exports.fakeBus = function(handlers) {
  const mainBus = new bus.Bus();
  const ManagerType = function() {};
  
  util.inherits(ManagerType, buscomponent.BusComponent);
  
  const defaultHandlers = {
    'get-readability-mode': () => { return { readonly: false }; },
    'getServerConfig': () => cfg
  };
  
  handlers = _.defaults(handlers, defaultHandlers);
  
  for (const hname in handlers) {
    // better: allow injection-style array argument names
    const handler = handlers[hname];
    const argumentNames = String(handler).match(/[^\(]*\(([^\)]*)\)/)[1].split(',').map(s => s.trim());
    ManagerType.prototype['handler_' + hname] = buscomponent.provide(hname, argumentNames, handler);
  }
  
  const manager = new ManagerType();
  return mainBus.init().then(() => {
    return manager.setBus(mainBus, 'test-manager');
  }).then(() => {
    // better way: destructuring
    mainBus.manager = manager;
    return mainBus;
  });
};
