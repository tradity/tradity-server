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

  describe('/achievements/list', function() {
    it('Should be successful and return multiple achievement types', function() {
      return socket.get('/achievements/list').then(result => {
        assert.ok(result._success);
        assert.ok(result.data.length > 0);
        
        for (let i = 0; i < result.data.length; ++i) {
          assert.ok(result.data[i].name);
          assert.ok(result.data[i].xp >= 0);
          assert.ok(result.data[i].category);
        }
      });
    });
  });
  
  describe('/achievements/client/daily-login-cert', function() {
    it('Should be successful and return a valid server certificate', function() {
      return socket.get('/achievements/client/daily-login-cert').then(result => {
        assert.ok(result._success);
        assert.ok(result.data);
        assert.equal(typeof result.data, 'string');
      });
    });
    
    it('Should fail with permission-denied when specifiying date', function() {
      return socket.get('/achievements/client/daily-login-cert', {
        qs: { today: '2015-12-31' }
      }).then(result => {
        assert.equal(result.code, 403);
      });
    });
  });
  
  describe('/achievements/client', function() {
    it('Should fail for unknown achievements', function() {
      return socket.post('/achievements/client', {
        body: { name: 'NONEXISTENT_ACHIEVEMENT' }
      }).then(result => {
        assert.equal(result.code, 404);
      });
    });
    
    it('Should fail for empty achievement names', function() {
      return socket.post('/achievements/client', {
        body: { name: '' }
      }).then(result => {
        assert.equal(result.code, 404);
      });
    });
    
    it('Should work for known achievements and result in an user-info-listed achievement', function() {
      let clientAchievementName;
      
      return socket.get('/achievements/list').then(res => {
        assert.ok(res._success);
        
        const clientAchievements = res.data.filter(ach => {
          return ach.isClientAchievement && !ach.requireVerified;
        });
        
        assert.notEqual(clientAchievements.length, 0);
        
        clientAchievementName = clientAchievements[0].name;
        
        return socket.post('/achievements/client', {
          body: { name: clientAchievementName }
        });
      }).then(result => {
        assert.ok(result._success);
        
        return socket.get('/user/$self', { cache: false });
      }).then(userInfo => {
        assert.ok(userInfo._success);
        
        const achievementNames = userInfo.achievements.map(ach => ach.achname);
        
        assert.notStrictEqual(achievementNames.indexOf(clientAchievementName), -1);
      });
    });
  });
  
  describe('/achievements/client/daily-login-cert', function() {
    it('Should register achievements for being logged in multiple days in a row', function() {
      return _.range(2, 10).map(N => {
        return () => {
          const now = Date.now();
          
          // compute dates of the previous 10 days
          const dates = _.range(0, N).map(x => {
            return new Date(now - x * 86400 * 1000).toJSON().substr(0, 10);
          });
          
          return Promise.all(dates.map(date => {
            return socket.get('/achievements/client/daily-login-cert', {
              __sign__: true,
              qs: { today: date }
            }).then(result => {
              assert.ok(result._success);
              
              return result.data;
            });
          })).then(certs => {
            return socket.post('/achievements/client/daily-login-submit', {
              body: { certs: certs }
            });
          }).then(result => {
            assert.ok(result._success);
            
            return socket.get('/user/$self', { cache: false, __sign__: true });
          }).then(userInfo => {
            assert.ok(userInfo._success);
            
            const achievementNames = userInfo.achievements.map(ach => ach.achname);
            
            assert.notStrictEqual(achievementNames.indexOf('DAILY_LOGIN_DAYS_' + N), -1);
          });
        };
      }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve());
    });
    
    it('Should fail when no certificates are given', function() {
      return socket.post('/achievements/client/daily-login-submit').then(result => {
        assert.equal(result.code, 400);
      });
    });
    
    it('Should fail when invalid certificates are given', function() {
      return socket.post('/achievements/client/daily-login-submit', {
        body: { certs: ['XXX'] }
      }).then(result => {
        assert.strictEqual(result.code, 200);
        assert.strictEqual(result.streak, 1);
      });
    });
    
    it('Should register achievements for being logged in multiple days with breaks', function() {
      const now = Date.now();
      
      const dates = [2,3,4,6,7].map(x => {
        return new Date(now - x * 86400 * 1000).toJSON().substr(0, 10);
      });
      
      return Promise.all(dates.map(date => {
        return socket.get('/achievements/client/daily-login-cert', {
          __sign__: true,
          qs: { today: date }
        }).then(result => {
          assert.ok(result._success);
          
          return result.data;
        });
      })).then(certs => {
        return socket.post('/achievements/client/daily-login-submit', {
          body: { certs: certs }
        });
      }).then(result => {
        assert.strictEqual(result.code, 200);
        assert.strictEqual(result.streak, 3);
      });
    });
  });
});
