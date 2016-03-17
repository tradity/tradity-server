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

const assert = require('assert');
const api = require('./api.js');
const debug = require('debug')('sotrade:misc');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

class GetOwnOptions extends api.Requestable {
  constructor() {
    super({
      url: '/options',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      description: 'Return all information about the current user.'
    });
  }
  
  handle(query, ctx) {
    assert.ok(ctx.user);
    
    const r = Object.assign({}, ctx.user);
    assert.ok(!r.pwsalt);
    assert.ok(!r.pwhash);
    return { code: 200, data: r };
  }
}

class SetClientstorage extends api.Requestable {
  constructor() {
    super({
      url: '/options/clientstorage',
      methods: ['PUT'],
      writing: true,
      returns: [
        { code: 204 }
      ],
      description: 'Update the client storage for a certain user with arbitrary data.'
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata) {
    return promiseUtil.bufferFromStream(xdata.rawRequest).then(storage => {
      assert.ok(Buffer.isBuffer(storage));
      
      return ctx.query('UPDATE users_data SET clientstorage = ? WHERE uid = ?', [storage, ctx.user.uid]);
    }).then(() => {
      return { code: 204 };
    });
  }
}

class Ping extends api.Requestable {
  constructor() {
    super({
      identifier: 'Ping',
      url: '/ping',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      requiredLogin: false,
      description: 'Says hello.'
    });
  }
  
  handle(query, ctx) {
    return { code: 200, ping: 'pong', uid: ctx.user ? ctx.user.uid : null };
  }
}

class ArtificialError extends api.Requestable {
  constructor() {
    super({
      url: '/artificial-error',
      methods: ['POST'],
      writing: 'maybe',
      returns: [
        { code: 204 }
      ],
      requiredAccess: 'server',
      description: 'Throws an error (for testing error handling systems).'
    });
  }
  
  handle(/*query, ctx*/) {
    debug('Creating artificial error');
    this.load('PubSub').emit('error', new Error('Client-induced non-failure'));
    return { code: 204 };
  }
}

class ArtificialDeadlock extends api.Requestable {
  constructor() {
    super({
      url: '/artificial-deadlock',
      methods: ['POST'],
      returns: [
        { code: 204 }
      ],
      writing: true,
      requiredAccess: 'server',
      description: 'Internally produces a database deadlock (for testing purposes).'
    });
  }
  
  handle(query, ctx) {
    debug('Creating artificial deadlock');
    let conn1, conn2, id;
    const deferred = Promise.defer();
    
    return ctx.query('CREATE TABLE IF NOT EXISTS deadlocktest (id INT AUTO_INCREMENT, value INT, PRIMARY KEY (id))').then(() => {
      return ctx.query('INSERT INTO deadlocktest (value) VALUES (0), (0)');
    }).then(r => {
      id = r.insertId;
      return ctx.startTransaction({}, {restart: () => {
        return ctx.query('DROP TABLE deadlocktest').then(() => {
          return deferred.resolve({ code: 204 });
        });
      }});
    }).then(conn1_ => {
      conn1 = conn1_;
      return ctx.startTransaction();
    }).then(conn2_ => {
      conn2 = conn2_;
      return conn1.query('UPDATE deadlocktest SET value = 1 WHERE id = ?', [id]);
    }).then(() => {
      return conn2.query('UPDATE deadlocktest SET value = 2 WHERE id = ?', [id+1]);
    }).then(() => {
      return conn1.query('UPDATE deadlocktest SET value = 3 WHERE id = ?', [id+1]);
    }).then(() => {
      return conn2.query('UPDATE deadlocktest SET value = 4 WHERE id = ?', [id]);
    }).then(() => {
      return deferred.promise;
    });
  }
}

class ArtificialStaleLock extends api.Requestable {
  constructor() {
    super({
      url: '/artificial-stalelock',
      methods: ['POST'],
      writing: true,
      returns: [
        { code: 204 }
      ],
      requiredAccess: 'server',
      description: 'Internally produces a DB transaction which is released after 5 minutes.'
    });
  }
  
  handle(query, ctx) {
    debug('Creating artificial stale lock');
    
    let conn;
    return ctx.startTransaction({httpresources: 'w'}).then(conn_ => {
      conn = conn_;
      return promiseUtil.delay(5 * 60000);
    }).then(() => conn.commit()).then(() => ({code: 204}));
  }
}

class ForceReadonly extends api.Requestable {
  constructor() {
    super({
      url: '/force-readonly',
      methods: ['POST'],
      writing: 'maybe',
      returns: [
        { code: 204 }
      ],
      schema: {
        type: 'object',
        properties: {
          readonly: { type: 'boolean' }
        },
        required: ['readonly']
      },
      requiredAccess: 'server',
      description: 'Throws an error (for testing error handling systems).'
    });
  }
  
  handle(query/*, ctx*/) {
    debug('Force into readability mode', query.readonly);
    
    this.load('ReadonlyStore').readonly = query.readonly;
    
    return { code: 204 };
  }
}

class ArtificialDBError extends api.Requestable {
  constructor() {
    super({
      url: '/artificial-db-error',
      methods: ['POST'],
      writing: true,
      returns: [
        { code: 200 }
      ],
      requiredAccess: 'server',
      description: 'Internally produces a DB error.'
    });
  }
  
  handle(query, ctx) {
    debug('Query with invalid SQL');
    
    return ctx.query('INVALID SQL').catch(err => {
      return { code: 200, data: { err: err } };
    });
  }
}

class GatherPublicStatistics extends api.Requestable {
  constructor() {
    super({
      url: '/statistics',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      requiredLogin: false,
      description: 'Presents statistics that can safely be displayed to the general public.'
    });
  }
  
  handle(query, ctx) {
    return Promise.all([
      ctx.query('SELECT COUNT(*) AS c FROM users WHERE deletiontime IS NULL'),
      ctx.query('SELECT COUNT(*) AS c FROM orderhistory'),
      ctx.query('SELECT COUNT(*) AS c FROM schools')
    ]).then(spread((ures, ores, sres) => {
      return {
        code: 200,
        userCount: ures[0].c,
        tradeCount: ores[0].c,
        schoolCount: sres[0].c
      };
    }));
  }
}

exports.components = [
  GetOwnOptions,
  SetClientstorage,
  Ping,
  ArtificialDBError,
  ArtificialDeadlock,
  ArtificialError,
  ArtificialStaleLock,
  ForceReadonly,
  GatherPublicStatistics
];
