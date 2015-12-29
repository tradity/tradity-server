'use strict';

const assert = require('assert');
const mocks = require('./mocks.js');

const events = require('events');
const Q = require('q');
const ConnectionData = require('../../connectiondata.js').ConnectionData;

describe('ConnectionData', () => {
  it('Should request feedFetchEvents upon receiving push-events', () => {
    const deferred = Q.defer();
    let ffeCount = 0;
    
    return mocks.fakeBus({
      'feedFetchEvents': () => {
        if (++ffeCount == 2) {
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
      }

      return Q.all([fakeConnection(), fakeConnection()]).then(() => {
        bus.manager.emitGlobal('push-events');
      });
    }).then(() => deferred.promise);
  });
});
