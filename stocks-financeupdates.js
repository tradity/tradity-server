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

const _ = require('lodash');
const lapack = require('lapack');
const UnionFind = require('unionfind');
const assert = require('assert');
const debug = require('debug')('sotrade:stocks-fu');
const api = require('./api.js');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

const wprovMax = 'GREATEST(ds.provision_hwm, s.bid)';
const wprovΔ = '(('+wprovMax+' - ds.provision_hwm) * ds.amount)';
const wprovFees = '(('+wprovΔ+' * l.wprovision) / 100)';
const lprovMin = 'LEAST(ds.provision_lwm, s.bid)';
const lprovΔ = '(('+lprovMin+' - ds.provision_lwm) * ds.amount)';
const lprovFees = '(('+lprovΔ+' * l.lprovision) / 100)';

class UpdateProvisions extends api.Component {
  constructor() {
    super({
      identifier: 'UpdateProvisions',
      description: 'Update all provision values in the user finance fields.',
      notes: 'The provisions are calculated according to: <br />\n' +
      '<math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">' +
        '<mrow>' +
           'Gain provision =' +
           '(max{HWM, bid} - HWM) · (number of shares)' +
           '· <mfrac><mrow>(gain provision percentage)</mrow><mrow>100</mrow></mfrac>' +
        '</mrow>' +
        '<mrow>' +
           'Loss provision =' +
            '(min{LWM, bid} - LWM) · (number of shares)' +
            '· <mfrac><mrow>(loss provision percentage)</mrow><mrow>100</mrow></mfrac>' +
        '</mrow>' +
    '</math> <br />\n' +
    'where HWM and LWM stand for high and low water mark, respectively.\n' +
   
    'After paying the provisions, all HWMs and LWMs are set to their new marks.' +
    'They are not – as it was the case in earlier revisions of this software – ' +
    'reset after a given amount of time, but rather persist over the entire span ' +
    'of time in which the users holds shares of the corresponding leader.'
    });
  }
  
  handle(ctx) {
    debug('Update provisions');
    
    return ctx.startTransaction([
      { name: 'depot_stocks', alias: 'ds', mode: 'w' },
      { name: 'users_finance', alias: 'l', mode: 'w' },
      { name: 'users_finance', alias: 'f', mode: 'w' },
      { name: 'stocks', alias: 's', mode: 'r' },
      { name: 'transactionlog', mode: 'w' }
    ]).then(conn => {
      return conn.query('SELECT ' +
        'ds.depotentryid AS dsid, s.stocktextid, ' +
        wprovFees + ' AS wfees, ' + wprovMax + ' AS wmax, ' +
        lprovFees + ' AS lfees, ' + lprovMin + ' AS lmin, ' +
        'ds.provision_hwm, ds.provision_lwm, s.bid, ds.amount, ' +
        'f.uid AS fid, l.uid AS lid ' +
        'FROM depot_stocks AS ds JOIN stocks AS s ON s.stockid = ds.stockid ' +
        'JOIN users_finance AS f ON ds.uid = f.uid ' +
        'JOIN users_finance AS l ON s.leader = l.uid AND f.uid != l.uid')
      .then(dsr => {
      return Promise.all(dsr.map(entry => {
        assert.ok(entry.wfees >= 0);
        assert.ok(entry.lfees <= 0);
        entry.wfees = parseInt(entry.wfees);
        entry.lfees = parseInt(entry.lfees);
        
        const totalfees = entry.wfees + entry.lfees;
        
        return (Math.abs(totalfees) < 1 ? Promise.resolve() : 
        conn.query('INSERT INTO transactionlog (orderid, type, stocktextid, a_user, p_user, amount, time, json) VALUES ' + 
          '(NULL, "provision", ?, ?, ?, ?, UNIX_TIMESTAMP(), ?)', 
          [entry.stocktextid, entry.fid, entry.lid, totalfees, JSON.stringify({
            reason: 'regular-provisions',
            provision_hwm: entry.provision_hwm,
            provision_lwm: entry.provision_lwm,
            bid: entry.bid,
            depot_amount: entry.amount
          })])
        ).then(() => {
        return conn.query('UPDATE depot_stocks AS ds SET ' +
          'provision_hwm = ?, wprov_sum = wprov_sum + ?, ' +
          'provision_lwm = ?, lprov_sum = lprov_sum + ? ' +
          'WHERE depotentryid = ?', [entry.wmax, entry.wfees, entry.lmin, entry.lfees, entry.dsid]);
        }).then(() => {
        return conn.query('UPDATE users_finance AS f SET freemoney = freemoney - ?, totalvalue = totalvalue - ? ' +
          'WHERE uid = ?',
          [totalfees, totalfees, entry.fid]);
        }).then(() => {
        return conn.query('UPDATE users_finance AS l SET freemoney = freemoney + ?, totalvalue = totalvalue + ?, ' +
          'wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? ' +
          'WHERE uid = ?',
          [totalfees, totalfees, entry.wfees, entry.lfees, entry.lid]);
        });
      })).then(conn.commit, conn.rollbackAndThrow);
      });
    });
  }
}

function identityMatrix(n) {
  const A = [];
  for (let i = 0; i < n; ++i) {
    const row = [];
    A.push(row);
    for (let j = 0; j < n; ++j) {
      row[j] = (i === j ? 1.0 : 0.0);
    }
  }
  
  return A;
}

class UpdateLeaderMatrix extends api.Component {
  constructor() {
    super({
      identifier: 'UpdateLeaderMatrix',
      description: 'Update the leader matrix values.',
      notes: 'This is quite complicated and deserves to be documented elsewhere ' +
        'and in greater detail (e.g., at ' +
        '<a href="https://doc.tradity.de/math/math.pdf">https://doc.tradity.de/math/math.pdf</a>)'
    });
  }
  
  handle(ctx, cfg) {
    const lmuStart = Date.now();
    let conn, cfg;
    
    debug('Update leader matrix');
    
    return ctx.startTransaction({
      depot_stocks: { alias: 'ds', mode: 'r' },
      users_finance: { mode: 'w' },
      stocks: { alias: 's', mode: 'w' }
    }).then(conn_ => {
      conn = conn_;
      
      return Promise.all([
        conn.query('SELECT DISTINCT ds.uid AS uid FROM depot_stocks AS ds ' +
          'UNION SELECT s.leader AS uid FROM stocks AS s WHERE s.leader IS NOT NULL'),
        conn.query('SELECT ds.uid AS uid, SUM(ds.amount * s.bid) AS valsum, SUM(ds.amount * s.ask) AS askvalsum, ' +
          'freemoney, users_finance.wprov_sum + users_finance.lprov_sum AS prov_sum ' +
          'FROM depot_stocks AS ds ' +
          'LEFT JOIN stocks AS s ON s.leader IS NULL AND s.stockid = ds.stockid ' +
          'LEFT JOIN users_finance ON ds.uid = users_finance.uid ' +
          'GROUP BY uid'),
        conn.query('SELECT uid, 0 AS askvalsum, 0 AS valsum, freemoney, wprov_sum + lprov_sum AS prov_sum ' +
          'FROM users_finance WHERE (SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.uid = users_finance.uid) = 0'),
        conn.query('SELECT s.leader AS luid, ds.uid AS fuid, ds.amount AS amount ' +
          'FROM depot_stocks AS ds JOIN stocks AS s ON s.leader IS NOT NULL AND s.stockid = ds.stockid')
      ]);
    })).then(spread((users, res_static, res_static2, res_leader) => {
      res_static = res_static.concat(res_static2);
      users = _.uniq(_.map(users, 'uid'));
      
      const lmuFetchData = Date.now();
      
      let uidToIndex = [];
      for (let k = 0; k < users.length; ++k) {
        uidToIndex[users[k]] = k;
      }
      
      let uidToResStaticIndex = [];
      for (let k = 0; k < res_static.length; ++k) {
        uidToResStaticIndex[res_static[k].uid] = k;
      }
        
      let followerToResLeaderIndices = [];
      for (let k = 0; k < res_leader.length; ++k) {
        const fuid = res_leader[k].fuid;
        if (followerToResLeaderIndices[fuid]) {
          followerToResLeaderIndices[fuid].push(k);
        } else {
          followerToResLeaderIndices[fuid] = [k];
        }
      }
      
      if (users.length === 0) {
        return;
      }
      
      // find connected components
      const uf = new UnionFind(users.length);
      for (let i = 0; i < res_leader.length; ++i) {
        uf.union(uidToIndex[res_leader[i].luid], uidToIndex[res_leader[i].fuid]);
      }
      
      const components = {};
      for (let i = 0; i < users.length; ++i) {
        if (!components[uf.find(i)]) {
          components[uf.find(i)] = [users[i]];
        } else {
          components[uf.find(i)].push(users[i]);
        }
      }
      
      debug('Found components', Object.keys(components).length, users.length + ' users');
      
      let sgesvTotalTime = 0, presgesvTotalTime = 0, postsgesvTotalTime = 0;
      let updateQuery = '';
      let updateParams = [];
      
      for (let ci in components) {
        const componentStartTime = Date.now();
        const cusers = components[ci];
        const n = cusers.length;
        
        const cuidToIndex = {};
        for (let k = 0; k < cusers.length; ++k) {
          cuidToIndex[cusers[k]] = k;
        }
        
        const A = identityMatrix(n); // slightly faster than the lodash equivalent via 2 map()s
        const B = _.map(_.range(n), () => [0.0, 0.0]);
        const prov_sum = _.map(_.range(n), () => [0.0]);
        
        for (let k = 0; k < cusers.length; ++k) {
          const uid = cusers[k];
          
          // res_static
          {
            const r = res_static[uidToResStaticIndex[uid]];
            const localIndex = cuidToIndex[uid];
            
            assert.strictEqual(r.uid, uid);
            assert.ok(localIndex < n);
            
            if (r.valsum === null) { // happens when one invests only in leaders
              r.valsum = 0;
            }
            
            B[localIndex] = [
              r.valsum    + r.freemoney - r.prov_sum,
              r.askvalsum + r.freemoney - r.prov_sum
            ];
            prov_sum[localIndex] = r.prov_sum;
          }
          
          // res_leader (is indexed by follwer uid)
          const rlIndices = followerToResLeaderIndices[uid];
          
          if (rlIndices) {
            for (let j = 0; j < rlIndices.length; ++j) {
              const r = res_leader[rlIndices[j]];
              
              assert.equal(r.fuid, uid); // the follower part is already known
              const l = cuidToIndex[r.luid]; // find leader uid
              
              // the leader MUST be in the same connected component
              assert.notEqual(typeof l, 'undefined');
              
              A[k][l] -= r.amount / cfg.leaderValueShare;
            }
          }
        }
        
        const sgesvST = Date.now();
        const res = lapack.sgesv(A, B);
        if (!res) {
          return this.load('PubSub').publish('error', new Error('SLE solution not found for\nA = ' + A + '\nB = ' + B));
        }
        
        const sgesvET = Date.now();
        sgesvTotalTime += sgesvET - sgesvST;
        presgesvTotalTime += sgesvST - componentStartTime;
        
        const X =  _.map(res.X, 0);
        const Xa = _.map(res.X, 1);

        for (let i = 0; i < n; ++i) {
          assert.notStrictEqual(X[i],  null);
          assert.notStrictEqual(Xa[i], null);
          assert.equal(X[i],  X[i]);
          assert.equal(Xa[i], Xa[i]);
          assert.ok(cusers[i]);
          
          const lv  = X[i] / 100;
          const lva = Math.max(Xa[i] / 100, 10000);
          
          updateQuery += 'UPDATE stocks AS s SET lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), pieces = ? WHERE leader = ?;';
          updateParams.push((lv + lva)/2.0, lva, lv, lv < 10000 ? 0 : 100000000, cusers[i]);
          updateQuery += 'UPDATE users_finance SET totalvalue = ? WHERE uid = ?;';
          updateParams.push(X[i] + prov_sum[i], cusers[i]);
          
        }
        
        const componentEndTime = Date.now();
        postsgesvTotalTime += componentEndTime - sgesvET;
      }
      
      const lmuComputationsComplete = Date.now();
      let res;
      return conn.query(updateQuery, updateParams).then(() => {
        return conn.commitWithoutRelease();
      }).then(() => {
        return conn.query('SELECT stocktextid, lastvalue, ask, bid, stocks.name AS name, leader, users.name AS leadername ' +
          'FROM stocks JOIN users ON leader = users.uid WHERE leader IS NOT NULL');
      }).then(res_ => {
        res = res_;
        return conn.release();
      }).then(() => {
        const lmuEnd = Date.now();
        console.log('lmu timing: ' +
          presgesvTotalTime + ' ms pre-sgesv total, ' +
          sgesvTotalTime + ' ms sgesv total, ' +
          postsgesvTotalTime + ' ms post-sgesv total, ' +
          (lmuEnd - lmuStart) + ' ms lmu total, ' +
          (lmuFetchData - lmuStart) + ' ms fetching, ' +
          (lmuEnd - lmuComputationsComplete) + ' ms writing');
        
        return res.map(r => {
          return this.load('PubSub').publish('stock-update', r);
        });
      });
    }));
  }
}

exports.components = [
  UpdateProvisions,
  UpdateLeaderMatrix
];
