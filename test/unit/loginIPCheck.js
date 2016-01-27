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
const _ = require('lodash');
const LoginIPCheck = require('../../lib/loginIPCheck.js');

function mean(a) {
  return _.sum(a) / a.length;
}

function cov(a, b) {
  assert.strictEqual(a.length, b.length);
  const N = a.length;
  
  const Ea = mean(a), Eb = mean(b);
  
  return 1/(N - 1) * _.sum(_.range(N).map(function(i) {
    return (a[i] - Ea) * (b[i] - Eb);
  }));
}

function correlation(a, b) {
  return cov(a, b) / (Math.sqrt(cov(a, a) * cov(b, b)));
}

function stddev(a) {
  return Math.sqrt(cov(a, a));
}

describe('loginIPCheck', function() {
  it('should increase waiting time with the number of login attempts', function() {
    const check = new LoginIPCheck({
      base: 2,
      baseWait: 10
    });
    
    const deltas = [];
    const N = 7;
    
    let prev = Date.now();
    return _.range(N).map(() => {
      return () => {
        const now = Date.now();
        deltas.push(Math.log(now - prev));
        prev = now;
        
        return check.check('1:2:3::4');
      };
    }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve(null)).then(() => {
      const r = correlation(deltas.slice(1), _.range(N-1));
      assert.ok(r > 0.5, 'Correlation was only ' + r);
    });
  });
  
  it('should respect the minimum and maximum waiting time', function() {
    const maxWait = 100, minWait = 80;
    
    const check = new LoginIPCheck({
      base: 2,
      baseWait: minWait / 2,
      minWait: minWait,
      maxWait: maxWait
    });
    
    const N = 7;
    
    let prev = Date.now();
    return _.range(N).map(i => {
      return function() {
        const now = Date.now();
        
        assert.ok(i === 0 || now - prev <= maxWait * 1.5);
        assert.ok(i === 0 || now - prev >= minWait);
        
        prev = now;
        
        return check.check('1.2.3.4');
      };
    }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve(null));
  });
  
  it('should flush old infos', function() {
    const check = new LoginIPCheck({
      base: 2,
      baseWait: 10,
      flushTimeout: 5
    });
    
    const deltas = [];
    const N = 7;
    
    let prev = Date.now();
    return _.range(N).map(() => {
      return () => {
        const now = Date.now();
        deltas.push(Math.log(now - prev));
        prev = now;
        
        return check.check('1:2:3::4');
      };
    }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve(null)).then(function() {
      deltas.shift();
      
      const relStddev = stddev(deltas) / mean(deltas);
      
      assert.ok(relStddev < 0.1, 'Unexpected relative stddev was ' + relStddev);
    });
  });
  
  it('should return a string representation via .toString()', function() {
    const check = new LoginIPCheck();
    assert.ok(check.toString());
  });
});
