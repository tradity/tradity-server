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
  
  return 1/(N - 1) * _.sum(_.range(N), function(i) {
    return (a[i] - Ea) * (b[i] - Eb);
  });
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
