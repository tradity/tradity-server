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

describe('wordpress-feed', function() {
  let socket, user;
  
  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('process-wordpress-feed', function() {
    it('Should work', function() {
      return socket.post('/wordpress/processFeed', {
        __sign__: true
      }).then(res => {
        assert.ok(res._success);
      });
    });
  });
  
  describe('/wordpress/addFeed', function() {
    it('Should add a wordpress feed entry which can later be removed', function() {
      const endpoint = 'https://example.com/' + Date.now();
      
      return socket.post('/wordpress/addFeed', {
        __sign__: true,
        body: {
          endpoint: endpoint,
          category: null,
          schoolid: null,
          bloguser: user.uid
        }
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/wordpress/feeds', { __sign__: true });
      }).then(res => {
        assert.ok(res._success);
        
        const recentEntry = res.data.filter(function(blog) {
          return blog.endpoint === endpoint;
        })[0];
        
        assert.ok(recentEntry);
        
        return socket.delete('/wordpress/feeds/' + recentEntry.blogid, {
          __sign__: true
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/wordpress/feeds', { __sign__: true });
      }).then(res => {
        assert.ok(res._success);
        
        assert.equal(_.map(res.data, 'endpoint').indexOf(endpoint), -1);
      });
    });
  });
});
