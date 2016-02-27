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
const sha256 = require('../../lib/sha256.js');
const parentPath = require('../../lib/parentpath.js');
const testHelpers = require('./test-helpers.js');
const promiseUtil = require('../../lib/promise-util.js');
const spread = promiseUtil.spread;

describe('admin', function() {
  let user, socket;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      user = data.user;
      socket = data.socket;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('/users', function() {
    it('Should fail for non-admin users', function() {
      return socket.get('/users').then(result => {
        assert.equal(result.code, 403);
      });
    });
    
    it('Should provide a list of all users', function() {
      return socket.get('/users', { __sign__: true }).then(result => {
        assert.ok(result._success);
        
        assert.ok(result.data.length > 0);
        const ownUserEntry = result.data.filter(listedUser => {
          return listedUser.name === user.name;
        })[0];
        
        assert.ok(ownUserEntry);
        assert.equal(ownUserEntry.giv_name, 'John');
        assert.ok(ownUserEntry.registertime > Date.now()/1000 - 1000);
        assert.ok(ownUserEntry.registertime < Date.now()/1000);
      });
    });
  });
  
  describe('/impersonate', function() {
    it('Should fail for non-admin users', function() {
      return socket.post('/impersonate/' + user.uid).then(result => {
        assert.equal(result.code, 403);
      });
    });
    
    it('Should fail for impersonating invalid users', function() {
      return socket.post('/impersonate/ABC', {
        __sign__: true
      }).then(result => {
        assert.equal(result.code, 400);
      });
    });
    
    it('Should fail for impersonating nonexistent users', function() {
      return socket.post('/impersonate/-1', {
        __sign__: true
      }).then(result => {
        assert.equal(result.code, 404);
      });
    });
    
    it('Should leave the session untouched when impersonating the active user', function() {
      return socket.post('/impersonate/' + user.uid, {
        __sign__: true
      }).then(result => {
        assert.ok(result._success);
        
        return socket.get('/user/$self', {
          cache: false, __sign__: true
        });
      }).then(userInfo => {
        assert.ok(userInfo._success);
        
        assert.strictEqual(userInfo.data.uid, user.uid);
        assert.strictEqual(userInfo.data.name, user.name);
      });
    });
  });
  
  describe('/user/…/email', function() {
    it('Should fail for invalid user ids', function() {
      return socket.put('/user/Banana/email', {
        __sign__: true
      }).then(result => {
        assert.equal(result.code, 400);
      });
    });
    
    it('Should be able to change the active user’s mail address', function() {
      const email = 'nonexistent' + parseInt(Math.random() * 100000) + '@invalid.invalid';
      
      return socket.put('/user/' + user.uid + '/email', {
        __sign__: true,
        body: {
          emailverif: true,
          email: email
        }
      }).then(result => {
        assert.ok(result._success);
        user.email = email;
      });
    });
  });
  
  describe('/events/comments/…', function() {
    it('Should be able to change the text of a recently made comment', function() {
      const newCommentText = '<a>New comment</a>';
      const newCState = 'Banananana';
      
      return socket.get('/user/$self', {
        cache: false, __sign__: true
      }).then(userInfo => {
        assert.ok(userInfo._success);
        assert.ok(userInfo.data.registerevent);
        
        return socket.post('/events/' + userInfo.data.registerevent + '/comments', {
          __sign__: true,
          body: {
            comment: 'Old comment'
          }
        });
      }).then(result => {
        assert.ok(result._success);
        
        return socket.get('/user/$self', {
          cache: false, __sign__: true
        });
      }).then(userInfo => {
        assert.ok(userInfo._success);
        
        assert.ok(userInfo.pinboard);
        assert.ok(userInfo.pinboard.length > 0);
        
        return socket.put('/events/comments/' + userInfo.pinboard[0].commentid, {
          __sign__: true,
          body: {
            comment: newCommentText,
            trustedhtml: true,
            cstate: newCState
          }
        });
      }).then(result => {
        assert.ok(result._success);
        
        return socket.get('/user/$self', {
          cache: false, __sign__: true
        });
      }).then(userInfo => {
        assert.ok(userInfo._success);
        
        assert.ok(userInfo.pinboard);
        assert.ok(userInfo.pinboard.length > 0);
        assert.equal(userInfo.pinboard[0].comment, newCommentText);
        assert.equal(userInfo.pinboard[0].cstate, newCState);
        assert.ok(userInfo.pinboard[0].trustedhtml);
      });
    });
  });
  
  describe('/mod-notifications/unstick-all', function() {
    it('Should remove the sticky flag from all moderator notifications', function() {
      return socket.post('/mod-notifications/unstick-all', {
        __sign__: true
      }).then(result => {
        assert.ok(result._success);
      });
    });
  });
  
  describe('/mod-notifications', function() {
    it('Should write events to all feeds', function() {
      return Promise.all([
        socket.post('/mod-notifications', {
          __sign__: true,
          body: {
            content: 'DON’T PANIC',
            sticky: true
          }
        }).then(result => {
          assert.ok(result._success);
        }),
        socket.once('feed-mod-notification')
      ]);
    });
  });
  
  describe('/school/…/name', function() {
    it('Should fail for nonexistent schools', function() {
      return socket.put('/school/-1/name', {
        __sign__: true,
        body: {
          schoolname: 'SCHOOL 42',
          schoolpath: '/abcdef'
        }
      }).then(res => {
        assert.equal(res.code, 404);
      });
    });
    
    it('Should change the name of a school', function() {
      let school;
      
      return socket.get('/schools').then(res => {
        assert.ok(res.data.length > 0);
        school = res.data.filter(s => parentPath(s) === '/')[0];
        
        return socket.put('/school/' + school.schoolid + '/name', {
          __sign__: true,
          body: {
            schoolname: 'SCHOOL 42',
            schoolpath: '/nonexistent/invalidPath'
          }
        });
      }).then(res => {
        assert.equal(res.code, 404);
        
        return socket.put('/school/' + school.schoolid + '/name', {
          __sign__: true,
          body: {
            schoolname: 'SCHOOL 42',
            schoolpath: '/' + sha256(school.path)
          }
        });
      }).then(res => {
        assert.ok(res._success);
        
        // rename again without really changing the school path
        return socket.put('/school/' + school.schoolid + '/name', {
          __sign__: true,
          body: {
            schoolname: 'SCHOOL 42',
            schoolpath: '/' + sha256(school.path)
          }
        });
      }).then(res => {
        assert.equal(res.code, 403);
        
        // do not give a school path this time
        return socket.put('/school/' + school.schoolid + '/name', {
          __sign__: true,
          body: {
            schoolname: 'SCHOOL 42'
          }
        });
      }).then(res => {
        assert.ok(res._success);
      });
    });
  });
  
  describe('/school/…/merge/…', function() {
    it('Should merge two schools together', function() {
      const prefix = 'S' + Date.now();
      let id1, id2;
      
      return Promise.all([prefix + 'Aj', prefix + 'Bj'].map(name => {
        return socket.post('/school', {
          __sign__: true,
          body: {
            schoolname: name
          }
        }).then(res => {
          assert.ok(res._success);
          
          return socket.get('/school-exists', {
            qs: { lookfor: res.path }
          });
        }).then(res => {
          assert.ok(res._success);
          assert.ok(res.data.exists);
          assert.ok(res.data.path);
          assert.strictEqual(typeof res.data.schoolid, 'number');
          
          return res.data.schoolid;
        });
      })).then(spread((id1_, id2_) => {
        id1 = id1_, id2 = id2_;
        
        return socket.post('/school/' + id1 + '/merge/' + id2, {
          __sign__: true
        });
      })).then(res => {
        assert.ok(res._success);
        
        return socket.get('/schools');
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.notEqual(_.map(res.data, 'schoolid').indexOf(id1), -1);
        assert.equal   (_.map(res.data, 'schoolid').indexOf(id2), -1);
      });
    });
    
    it('Should fail if one of the schools does not exist', function() {
      return socket.get('/schools').then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        
        const existentIDs = _.map(res.data, 'schoolid');
        const nonexistentID = (Math.max.apply(Math, existentIDs) || 0) + 1;
        
        return socket.post('/school/' + nonexistentID + '/merge/' + (nonexistentID + 1), {
          __sign__: true,
        });
      }).then(res => {
        assert.equal(res.code, 404);
      });
    });
  });
  
  describe('/user/…/followers', function() {
    it('Should provide a list of followers', function() {
      let leader;
      const amount = 7;
      
      return socket.get('/users', {
        __sign__: true
      }).then(result => {
        assert.ok(result._success);
        assert.ok(result.data.length > 0);
        
        leader = result.data[0];
        
        return socket.post('/trade', {
          __sign__: true,
          body: {
            amount: amount,
            value: null,
            stockid: null,
            leader: leader.uid,
            forceNow: true
          }
        });
      }).then(result => {
        assert.ok(result._success);
        
        return socket.get('/user/' + leader.uid + '/followers', {
          __sign__: true
        });
      }).then(result => {
        assert.ok(result._success);
        assert.ok(result.data.length > 0);
        
        const ownUserFollowerEntry = result.data.filter(follower => follower.uid === user.uid)[0];
        
        assert.ok(ownUserFollowerEntry);
        assert.equal(ownUserFollowerEntry.amount, amount);
      });
    });
  });
  
  describe('/activity/ticks', function() {
    it('Should return a timeline of tick statistics', function() {
      return socket.post('/regular-callback', { __sign__: true }).then(() => {
        return socket.get('/activity/ticks', { __sign__: true });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.length > 0);
        assert.ok(res.data[0].timeindex);
        assert.ok(res.data[0].ticksum);
      });
    });
  });
  
  describe('/activity/events', function() {
    it('Should return a histogram of event counts', function() {
      return socket.get('/activity/events', {
        __sign__: true,
        qs: {
          ndays: 10000
        }
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.length > 0);
        assert.ok(res.data[0].timeindex);
        
        // only days where events *happened* included
        // -> this should be okay
        assert.ok(res.data[0].nevents);
        assert.ok(res.data[0].nuser);
      });
    });
    
    it('Should return a histogram of event counts, filtered by type', function() {
      return socket.get('/activity/events', {
        __sign__: true,
        qs: {
          ndays: 10000,
          types: 'comment' // XXX change this in the client
        }
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.length > 0);
        assert.ok(res.data[0].timeindex);
        
        // only days where events *happened* included
        // -> this should be okay
        assert.ok(res.data[0].nevents);
        assert.ok(res.data[0].nuser);
      });
    });
  });
  
  describe('/events (omitUidFilter == true)', function() {
    it('Should return all events within a given timespan', function() {
      return socket.get('/events', {
        __sign__: true,
        qs: {
          omitUidFilter: true,
          includeDeletedComments: true,
          since: 1446054731,
          upto: 1446054955 // events for these dates are in the test DB
        }
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.length > 0);
        assert.ok(res.data[0].eventtime);
      });
    });
  });
});
