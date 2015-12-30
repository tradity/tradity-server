'use strict';

const assert = require('assert');
const fs = require('fs');
const _ = require('lodash');
const testHelpers = require('./test-helpers.js');
const promiseUtil = require('../../lib/promise-util.js');

describe('schools', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  const getOwnSchool = function() {
    return socket.emit('get-user-info', {
      lookfor: '$self'
    }).then(res => {
      assert.equal(res.code, 'get-user-info-success');
      assert.ok(res.result.schools);
      assert.ok(res.result.schools.length > 0);
      return res.result.schools[0];
    });
  };

  describe('get-school-info', function() {
    it('Should return information on a given school', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.ok(res.result);
        assert.ok(res.result.name);
        assert.equal(school.schoolid, res.result.schoolid);
        
        return socket.emit('school-exists', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'school-exists-success');
        assert.ok(res.exists);
        assert.equal(res.path, school.path);
      });
    });
  });
  
  describe('school-exists', function() {
    it('Should indicate whether a school exists', function() {
      return socket.emit('school-exists', {
        lookfor: '/nonexistent'
      }).then(res => {
        assert.equal(res.code, 'school-exists-success');
        assert.ok(!res.exists);
      });
    });
  });
  
  describe('school-change-description', function() {
    if (!testHelpers.testPerformance)
    it('Requires school admin privileges', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.emit('school-change-description', {
          schoolid: school.schoolid,
          descpage: 'Bla bla bla'
        });
      }).then(res => {
        assert.equal(res.code, 'permission-denied');
      });
    });
    
    it('Should change a school’s description text', function() {
      let school;
      const descpage = 'Blahlahblah';
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.emit('school-change-description', {
          __sign__: true,
          schoolid: school.schoolid,
          descpage: descpage
        });
      }).then(res => {
        assert.equal(res.code, 'school-change-description-success');
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.equal(res.result.descpage, descpage);
      });
    });
  });
  
  describe('school-change-member-status', function() {
    it('Should toggle admin status', function() {
      var school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.emit('school-change-member-status', {
          __sign__: true,
          schoolid: school.schoolid,
          status: 'admin',
          uid: user.uid
        });
      }).then(res => {
        assert.equal(res.code, 'school-change-member-status-success');
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.ok(res.result.admins);
        assert.ok(res.result.admins.length > 0);
        assert.notEqual(_.pluck(res.result.admins, 'adminid').indexOf(user.uid), -1);
        
        return socket.emit('school-change-member-status', {
          schoolid: school.schoolid,
          status: 'member',
          uid: user.uid
        });
      }).then(res => {
        assert.equal(res.code, 'school-change-member-status-success');
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.ok(res.result.admins);
        assert.equal(_.pluck(res.result.admins, 'adminid').indexOf(user.uid), -1);
      });
    });
  });
  
  describe('school-delete-comment', function() {
    it('Should delete a comment on a school pinboard', function() {
      var school;
      var eventid;
      var origCommentText = 'Stupid text';
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.ok(res.result);
        assert.ok(res.result.eventid);
        eventid = res.result.eventid;
        
        return socket.emit('comment', {
          eventid: eventid,
          comment: origCommentText
        });
      }).then(res => {
        assert.equal(res.code, 'comment-success');
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.ok(res.result);
        
        var comments = res.result.comments;
        assert.ok(comments);
        assert.ok(comments.length > 0);
        
        var comment = comments.sort((a, b) => { return b.time - a.time; })[0]; // most recent comment
        assert.equal(comment.comment, origCommentText);
        
        return socket.emit('school-delete-comment', {
          __sign__: true,
          schoolid: school.schoolid,
          commentid: comment.commentid
        });
      }).then(res => {
        assert.equal(res.code, 'school-delete-comment-success');
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.ok(res.result);
        
        var comments = res.result.comments;
        assert.ok(comments);
        assert.ok(comments.length > 0);
        
        var comment = comments.sort((a, b) => { return b.time - a.time; })[0]; // most recent comment
        assert.ok(comment.cstate == 'gdeleted');
      })
    });
  });
  
  if (!testHelpers.testPerformance)
  describe('school-kick-user', function() {
    it('Should remove the current user from their group', function() {
      var school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.emit('school-kick-user', {
          __sign__: true,
          uid: user.uid,
          schoolid: school.schoolid
        });
      }).then(res => {
        assert.equal(res.code, 'school-kick-user-success');
        
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true
        });
      }).then(res => {
        assert.equal(res.code, 'get-user-info-success');
        assert.ok(res.result.schools);
        assert.equal(res.result.schools.length, 0);
        
        return socket.emit('get-own-options');
      }).then(res => {
        assert.equal(res.code, 'get-own-options-success');
        res.result.school = school.schoolid;
        
        return socket.emit('change-options', res.result);
      }).then(res => {
        assert.equal(res.code, 'reg-success');
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true
        });
      }).then(res => {
        assert.equal(res.code, 'get-user-info-success');
        assert.ok(res.result.schools);
        assert.ok(res.result.schools.length > 0);
      });
    });
  });
  
  describe('create-school', function() {
    it('Should refuse to create already-existing schools', function() {
      return getOwnSchool().then(school => {
        return socket.emit('create-school', {
          __sign__: true,
          schoolname: 'Doublé',
          schoolpath: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'create-school-already-exists');
      });
    });
    
    it('Should not create schools with invalid paths', function() {
      return socket.emit('create-school', {
        __sign__: true,
        schoolname: 'Nonexistent Students of the World',
        schoolpath: '/nonexistent/nsotw'
      }).then(res => {
        assert.equal(res.code, 'create-school-missing-parent');
      });
    });
    
    it('Should create schools', function() {
      var path;
      return socket.emit('create-school', {
        __sign__: true,
        schoolname: 'S' + Date.now(),
      }).then(res => {
        assert.equal(res.code, 'create-school-success');
        path = res.path;
        
        return socket.emit('school-exists', {
          lookfor: path
        });
      }).then(res => {
        assert.equal(res.code, 'school-exists-success');
        assert.ok(res.exists);
        
        return socket.emit('list-schools');
      }).then(res => {
        assert.equal(res.code, 'list-schools-success');
        assert.ok(res.result);
        assert.notEqual(_.pluck(res.result, 'path').indexOf(path), -1);
      });
    });
  });
  
  describe('school-publish-banner', function() {
    it('Should provide schools with banners', function() {
      var school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return promiseUtil.nfcall(fs.readFile)('res/bob.jpg');
      }).then(data => {
        return socket.emit('school-publish-banner', {
          __sign__: true,
          base64: true,
          content: data.toString('base64'),
          schoolid: school.schoolid,
          mime: 'image/jpeg',
          name: 'bob.jpg'
        });
      }).then(res => {
        assert.equal(res.code, 'publish-success');
        
        return socket.emit('get-school-info', {
          lookfor: school.path
        });
      }).then(res => {
        assert.equal(res.code, 'get-school-info-success');
        assert.ok(res.result.banner);
      });
    });
  });
  
  describe('create-invite-link', function() {
    it('Should assign school IDs to invitation links', function() {
      var school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.emit('create-invite-link', {
          __sign__: true,
          email: null,
          schoolid: school.schoolid
        });
      }).then(res => {
        assert.equal(res.code, 'create-invite-link-success');
        assert.ok(res.key);
        
        return socket.emit('get-invitekey-info', {
          invitekey: res.key
        });
      }).then(res => {
        assert.equal(res.code, 'get-invitekey-info-success');
        assert.ok(res.result);
        assert.equal(res.result.schoolid, school.schoolid);
      });
    });
  });
});
