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

const TemplateReader = require('../../template-loader.js')
  .components.filter(c => c.name === 'TemplateReader')[0];

describe('TemplateReader', function() {
  const fakeConfigLoader = component => {
    assert.strictEqual(component, 'Config');
    
    return {
      config() {
        return {
          languages: [
            { id: 'de', name: 'Deutsch', englishName: 'German' },
            { id: 'en', name: 'English', englishName: 'English' }
          ]
        };
      }
    };
  };
  
  it('Loads a template and substitutes variables', function() {
    const r = new TemplateReader();
    
    r.load = fakeConfigLoader;
    
    return r.init().then(() => {
      return r.readTemplate('register-email.eml', 'en', {
        username: 'User 123',
        email: 'test@example.org',
        url: 'https://example.org/verify-email'
      });
    }).then(content => {
      assert.ok(content);
      assert.notStrictEqual(content.indexOf('User 123'), -1);
    });
  });
  
  it('Fails when variables for substition are missing', function() {
    const r = new TemplateReader();
    
    r.load = fakeConfigLoader;
    
    return r.init().then(() => {
      return r.readTemplate('register-email.eml', 'en', {
        username: 'User 123',
        url: 'https://example.org/verify-email'
      });
    }).then((/*content*/) => {
      assert.ok(false);
    }, err => {
      assert.ok(err.message.match(/Unknown variable/));
    });
  });
  
  it('Uses cached values when available', function() {
    const r = new TemplateReader();
    
    let hasCalled = 0, getCalled = 0;
    
    r.load = fakeConfigLoader;
    r.loadedTemplates = {
      has(entry) {
        assert.strictEqual(entry, 'en:register-email.eml');
        ++hasCalled;
        return true;
      },
      
      get(entry) {
        assert.strictEqual(entry, 'en:register-email.eml');
        ++getCalled;
        return 'Bananas';
      },
      
      set() {
        throw Error('.set() should not be called when using the cache');
      }
    };
    
    return r.init().then(() => {
      return r.readTemplate('register-email.eml', 'en', {
        username: 'User 123',
        url: 'https://example.org/verify-email'
      });
    }).then(content => {
      assert.strictEqual(content, 'Bananas');
      assert.strictEqual(hasCalled, 1);
      assert.strictEqual(getCalled, 1);
    });
  });
  
  it('Falls back to another language when the primary language is unavailable', function() {
    const r = new TemplateReader();
    
    r.load = fakeConfigLoader;
    
    return r.init().then(() => {
      return r.readTemplate('register-email.eml', 'xyz', {
        username: 'User 123',
        email: 'test@example.org',
        url: 'https://example.org/verify-email'
      });
    }).then(content => {
      assert.ok(content);
      assert.notStrictEqual(content.indexOf('User 123'), -1);
    });
  });
  
  it('Fails for unknown template names', function() {
    const r = new TemplateReader();
    
    r.load = fakeConfigLoader;
    
    return r.init().then(() => {
      return r.readTemplate('nonexistent-template.eml', 'de', {});
    }).then((/*content*/) => {
      assert.ok(false);
    }, err => {
      assert.ok(err.message.match(/Template not found/));
    });
  });
});
