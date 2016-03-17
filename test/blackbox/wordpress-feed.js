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
const nock = require('nock');
const testHelpers = require('./test-helpers.js');

describe('wordpress-feed', function() {
  let socket, user;
  
  before(function() {
    
    nock('https://example.com')
      .persist()
      .get(/\/posts$/)
      .reply(200, [
        {
          "link": "https://example.com/somewhere/",
          "modified": "2016-03-14T08:50:56",
          "parent": null,
          "modified_tz": "Etc/GMT+2",
          "comment_status": "open",
          "author": {
            "URL": "",
            "name": "authorx",
            "description": "",
            "registered": "2014-05-29T15:43:42+00:00",
            "ID": 7,
            "username": "authorx",
            "nickname": "authorx",
            "first_name": "authorx",
            "slug": "moritz"
          },
          "menu_order": 0,
          "excerpt": "<p>Excerpt</p>\n",
          "status": "publish",
          "date": "2016-03-13T23:50:37",
          "ping_status": "open",
          "type": "post",
          "sticky": false,
          "title": "Some title",
          "ID": 3855,
          "terms": {
            "category": [
              {
                "parent": null,
                "count": 15,
                "link": "https://example.com/uncategorized/",
                "slug": "uncategorized",
                "taxonomy": "category",
                "name": "Uncategorized",
                "description": "",
                "ID": 1
              }
            ]
          },
          "format": "standard",
          "slug": "authorx-wins-it-all",
          "content": "<h1>Content!</h1>\n",
          "modified_gmt": "2016-03-14T06:50:56",
          "guid": "https://example.com/?p=3855",
          "date_tz": "Etc/GMT+2",
          "date_gmt": "2016-03-13T21:50:37",
          "featured_image": null
        }
      ]);
    
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
      const path = Date.now();
      const endpoint = 'https://example.com/' + path;
      
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
        
        return socket.post('/wordpress/processFeed', {
          __sign__: true
        });
        
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
        
        assert.equal(res.data.map(f => f.endpoint).indexOf(endpoint), -1);
      });
    });
  });
});
