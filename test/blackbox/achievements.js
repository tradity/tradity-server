'use strict';

const assert = require('assert');
const _ = require('lodash');
const testHelpers = require('./test-helpers.js');

describe('achievements', function() {
  let socket;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('list-all-achievements', function() {
    it('Should be successful and return multiple achievement types', function() {
      return socket.emit('list-all-achievements').then(result => {
        assert.equal(result.code, 'list-all-achievements-success');
        
        assert.ok(result.result.length > 0);
        
        for (let i = 0; i < result.length; ++i) {
          assert.ok(result[i].name);
          assert.ok(result[i].xp >= 0);
          assert.ok(result[i].category);
        }
      });
    });
  });
  
  describe('get-daily-login-certificate', function() {
    it('Should be successful and return a valid server certificate', function() {
      return socket.emit('get-daily-login-certificate').then(result => {
        assert.equal(result.code, 'get-daily-login-certificate-success');
        
        assert.ok(result.cert);
      });
    });
    
    it('Should fail with permission-denied when specifiying date', function() {
      return socket.emit('get-daily-login-certificate', {
        today: '2015-12-31'
      }).then(result => {
        assert.equal(result.code, 'permission-denied');
      });
    });
  });
  
  describe('achievement', function() {
    it('Should fail for unknown achievements', function() {
      return socket.emit('achievement', {
        name: 'NONEXISTENT_ACHIEVEMENT'
      }).then(result => {
        assert.equal(result.code, 'achievement-unknown-name');
      });
    });
    
    it('Should fail for empty achievement names', function() {
      return socket.emit('achievement', {
        name: ''
      }).then(result => {
        assert.equal(result.code, 'format-error');
      });
    });
    
    it('Should work for known achievements and result in an user-info-listed achievement', function() {
      let clientAchievementName;
      
      return socket.emit('list-all-achievements').then(res => {
        assert.equal(res.code, 'list-all-achievements-success');
        
        const clientAchievements = res.result.filter(ach => {
          return ach.isClientAchievement && !ach.requireVerified;
        });
        
        assert.notEqual(clientAchievements.length, 0);
        
        clientAchievementName = clientAchievements[0].name;
        
        return socket.emit('achievement', {
          name: clientAchievementName
        });
      }).then(result => {
        assert.equal(result.code, 'achievement-success');
        
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true
        });
      }).then(userInfo => {
        assert.equal(userInfo.code, 'get-user-info-success');
        
        const achievementNames = userInfo.achievements.map(ach => ach.achname);
        
        assert.notStrictEqual(achievementNames.indexOf(clientAchievementName), -1);
      });
    });
  });
  
  describe('dl-achievement', function() {
    it('Should register achievements for being logged in multiple days in a row', function() {
      return _.range(2, 10).map(N => {
        return () => {
          const now = Date.now();
          
          // compute dates of the previous 10 days
          const dates = _.range(0, N).map(x => {
            return new Date(now - x * 86400 * 1000).toJSON().substr(0, 10);
          });
          
          return Promise.all(dates.map(date => {
            return socket.emit('get-daily-login-certificate', {
              __sign__: true,
              today: date
            }).then(result => {
              assert.equal(result.code, 'get-daily-login-certificate-success');
              
              return result.cert;
            });
          })).then(certs => {
            return socket.emit('dl-achievement', {
              certs: certs
            });
          }).then(result => {
            assert.equal(result.code, 'dl-achievement-success');
            
            return socket.emit('get-user-info', {
              lookfor: '$self',
              noCache: true, __sign__: true
            });
          }).then(userInfo => {
            assert.equal(userInfo.code, 'get-user-info-success');
            
            const achievementNames = userInfo.achievements.map(ach => ach.achname);
            
            assert.notStrictEqual(achievementNames.indexOf('DAILY_LOGIN_DAYS_' + N), -1);
          });
        };
      }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve());
    });
    
    it('Should fail when no certificates are given', function() {
      return socket.emit('dl-achievement').then(result => {
        assert.equal(result.code, 'format-error');
      });
    });
    
    it('Should fail when invalid certificates are given', function() {
      return socket.emit('dl-achievement', {
        certs: ['XXX']
      }).then(result => {
        assert.strictEqual(result.code, 'dl-achievement-success');
        assert.strictEqual(result.streak, 1);
      });
    });
    
    it('Should register achievements for being logged in multiple days in a row', function() {
      const now = Date.now();
      
      const dates = [2,3,4,6,7].map(x => {
        return new Date(now - x * 86400 * 1000).toJSON().substr(0, 10);
      });
      
      return Promise.all(dates.map(date => {
        return socket.emit('get-daily-login-certificate', {
          __sign__: true,
          today: date
        }).then(result => {
          assert.equal(result.code, 'get-daily-login-certificate-success');
          
          return result.cert;
        });
      })).then(certs => {
        return socket.emit('dl-achievement', {
          certs: certs
        });
      }).then(result => {
        assert.strictEqual(result.code, 'dl-achievement-success');
        assert.strictEqual(result.streak, 3);
      });
    });
  });
});
