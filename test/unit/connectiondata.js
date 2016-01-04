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

const mocks = require('./mocks.js');

const events = require('events');
const ConnectionData = require('../../connectiondata.js').ConnectionData;

describe('ConnectionData', function() {
  it('Should request feedFetchEvents upon receiving push-events', function() {
    const deferred = Promise.defer();
    let ffeCount = 0;
    
    return mocks.fakeBus({
      'feedFetchEvents': () => {
        if (++ffeCount === 2) {
          deferred.resolve();
        }
        
        return []; // connectiondata expects array return
      },
      'client-get-user-info': () => {
        return {
          code: 'get-user-info-success',
          result: {}
        };
      }
    }).then(bus => {
      const fakeConnection = () => {
        const fakeClient = new events.EventEmitter();
        fakeClient.handshake = {
          headers: { }
        };

        const conn = new ConnectionData(fakeClient);
        return conn.setBus(bus, 'cdata-' + conn.cdid).then(() => {
          conn.fakeClient_ = fakeClient;
          conn.ctx.user = { uid : 1 };
          return conn;
        });
      };

      return Promise.all([fakeConnection(), fakeConnection()]).then(() => {
        bus.manager.emitGlobal('push-events');
      });
    }).then(() => deferred.promise);
  });
});
