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

const Cache = require('./lib/minicache.js').Cache;
const Access = require('./access.js').Access;
const promiseEvents = require('promise-events');
const deepFreeze = require('deep-freeze');
const JSONStream = require('JSONStream');
const zlib = require('zlib');
const lzma = require('lzma-native');
const assert = require('assert');
const ZSchema = require('z-schema');
const Hawk = require('hawk');
const debug = require('debug')('sotrade:api');

const registryInit = Symbol('registryInit');
const runUserInit = Symbol('runUserInit');
const runUserInitPromise = Symbol('runUserInitPromise');
const _registry = Symbol('_registry');

class _Component extends promiseEvents.EventEmitter {
  constructor(options) {
    super();
    
    options = options || {};
    this.depends = options.depends || [];
    this[_registry] = null;
    this[runUserInitPromise] = null;
    
    this.identifier = options.identifier;
    this.anonymous = !!options.anonymous;
    this.local = !!options.local;
    
    if (!this.identifier && !this.anonymous && !this.local) {
      throw new TypeError('Component instances need either an identifier or be anonymous or local');
    }
  }
  
  initRegistryFromParent(obj) {
    assert.ok(obj[_registry]);
    assert.ok(this.anonymous);
    
    return Promise.resolve().then(() => {
      return this[registryInit](obj[_registry]);
    }).then(() => {
      return this[runUserInit]();
    });
  }
  
  [registryInit](registry) {
    this[_registry] = registry;
  }
  
  [runUserInit]() {
    if (this[runUserInitPromise]) {
      return this[runUserInitPromise];
    }
    
    return this[runUserInitPromise] =
    Promise.all(this.depends.map(dependency => {
      return Promise.resolve(this[_registry].load(dependency))
        .then(dep => {
        assert.strictEqual(typeof dep[runUserInit], 'function',
          'Dependency ' + dependency + ' has no [runUserInit]()');
        
        return dep[runUserInit]();
      });
    })).then(() => this.init());
  }
  
  init() {
  }
  
  load(dependency) {
    assert.ok(this[runUserInitPromise], 'Cannot call load() before initialization');
    
    assert.ok(this.depends.indexOf(dependency) !== -1,
      'Dependency ' + JSON.stringify(dependency) + ' not explicitly listed');
    
    return this[_registry].load(dependency);
  }
}

class Component extends _Component {
  constructor(options) {
    options = options || {};
    options.depends = ['Config', 'PubSub'].concat(options.depends || []);
    super(options);
  }
}

const addComponentInstance = Symbol('addComponentInstance');
class Registry extends _Component {
  constructor() {
    super({identifier: '_Registry'});
    
    this._dependencyIndex = new Map();
    this._instances = [];
    this._inited = false;
    
    this[addComponentInstance](this, Registry);
  }
  
  addComponentClass(Cls) {
    if (this._dependencyIndex.has(Cls)) {
      return this._dependencyIndex.get(Cls);
    }
    
    const instance = new Cls();
    
    assert.strictEqual(instance.constructor, Cls);
    
    return this[addComponentInstance](instance, Cls);
  }
  
  [addComponentInstance](instance, Cls) {
    this._dependencyIndex.set(Cls, instance);
    return this.addIndependentInstance(instance);
  }
  
  addIndependentInstance(instance) {
    this._dependencyIndex.set(instance.constructor, instance);
    
    if (instance.identifier) {
      if (this._dependencyIndex.has(instance.identifier)) {
        throw new Error('Registry already has entry for identifier ' + JSON.stringify(instance.identifier));
      }
      
      this._dependencyIndex.set(instance.identifier, instance);
    }
    
    this._instances.push(instance);
    return instance;
  }
  
  init() {
    if (this._inited) {
      return Promise.resolve();
    }
    
    this._inited = true;
    
    return Promise.all( this._instances.map(i => i[registryInit](this)) ).then(() => 
           Promise.all( this._instances.map(i => i[runUserInit]()) ));
  }
  
  listInstances() {
    return this._instances;
  }
  
  load(dependency) {
    const result = this._dependencyIndex.get(dependency);
    
    if (!result) {
      if (typeof dependency === 'function') {
        const instance = this.addComponentClass(dependency);
        return Promise.resolve()
          .then(() => instance[registryInit](this))
          .then(() => instance[runUserInit]())
          .then(() => instance);
      }
      
      throw new Error('Dependency not found: ' + String(dependency));
    }
    
    return result;
  }
}

class URLMatcher {
  constructor(paths) {
    this.paths = paths.map(path => {
      const parameters = [];
    
      let i = 1;
      const regexp = new RegExp('^' + path.replace(/\((\?:?)?/g, '(?:')
        .replace(/:([^/]+?)\b/g, (match, name) => {
        parameters[i++] = name;
        return '([^/]*)';
      }) + '$');
      
      return {
        regexp: regexp,
        parameters: parameters
      };
    });
  }
  
  match(url) {
    for (let i = 0; i < this.paths.length; ++i) {
      const match = url.match(this.paths[i].regexp);
      if (!match) {
        continue;
      }
      
      const parameters = this.paths[i].parameters;
      
      return Object.assign.apply(Object, [{}, match].concat(
        match.map((content, index) => ( // jshint ignore:line
          parameters[index] ? { [parameters[index]]: content } : {}
        ))
      ));
    }
    
    return null;
  }
}

// XXX
// this class is as new as it gets and still should kinda be refactored. sigh.
class Requestable extends Component {
  constructor(options) {
    if (!options.url) {
      throw new TypeError('Requestable instances need url property');
    }
    
    if (typeof options.url === 'string') {
      options = Object.assign(options, { url: [options.url] });
    }
    
    if (!options.identifier && !options.anonymous) {
      options = Object.assign({
        identifier: '_API: ' + options.url.join(',') + '@[' + (options.methods || ['GET']).join(',') + ']'
      }, options);
    }
    
    options = Object.assign({}, options, {
      depends: (options.depends || []).concat([
        'ReadonlyStore', 'UpdateUserStatistics', 'LoadSessionUser'
      ])
    });
    
    super(options);
    
    this.options = Object.assign({}, {
      transactional: false,
      writing: false,
      methods: ['GET'],
      returns: [ { code: 200 } ],
      requiredAccess: null,
      requiredLogin: true,
      schema: null
    }, options);
    
    this.urlMatcher = new URLMatcher(this.options.url);
    
    if (!this.options.description) {
      throw new TypeError('Description is neccessary for Requestable instances');
    }
    
    if (this.options.transactional) {
      this.options.writing = this.options.transactional;
    }
    
    this.options.methods = this.options.methods.map(m => m.toUpperCase());
    
    assert.notEqual([true, false, 'maybe'].indexOf(this.options.writing), -1);
    
    if (this.options.writing === true &&
        this.options.methods.indexOf('GET') !== -1) {
      throw new TypeError('Writing Requestable instances cannot use GET');
    }
    
    if (this.options.writing === false &&
        this.options.methods.indexOf('GET') === -1) {
      throw new TypeError('Non-writing Requestable instances must allow GET');
    }
    
    if (this.options.schema) {
      this.schema = Object.assign({}, this.options.schema);
      
      if (!this.schema.title) {
        this.schema.title = this.options.url.join(',') + ' (' + this.options.methods.join(', ') + ')';
      }
    }
    
    this.cache = new Cache();
    
    const requestable = this;
    
    this.ClientError = 
    class ClientError extends Error {
      constructor(identifier) {
        const info = requestable.options.returns.filter(r => r.identifier === identifier)[0];
        if (!info) {
          throw new TypeError('No identifier info available for ' + identifier);
        }
        
        super(requestable.options.url.join(',') + ': ' + info.code + ': ' + identifier);
        
        Object.assign(this, info);
      }
    };
    
    this.BadRequest =
    class BadRequest extends Error {
      constructor(underlying) {
        super('Bad Request: ' + String(underlying));
        
        this.code = 400;
        this.identifier = 'bad-request';
        this.schema = requestable.schema;
        this.underlying = underlying;
      }
    };
    
    this.MissingHandler =
    class MissingHandler extends Error {
      constructor() {
        super('Missing handler');
        
        this.code = 500;
        this.identifier = 'missing-handler';
      }
    };
    
    this.LoginRequired =
    class LoginRequired extends Error {
      constructor() {
        super('Login required');
        
        this.code = 401;
        this.identifier = 'login-required';
      }
    };
    
    this.Forbidden =
    class Forbidden extends Error {
      constructor() {
        super('Insufficient privileges');
        
        this.code = 403;
        this.identifier = 'insufficient-privileges';
      }
    };
    
    this.ServerReadonly =
    class ServerReadonly extends Error {
      constructor() {
        super('Server is read-only');
        
        this.code = 503;
        this.identifier = 'server-readonly';
      }
    };
  }
  
  // XXX: drop “school” from public API
  // XXX: test schema validation
  // XXX: decide on PermissionDenied
  // XXX: Docs?
  // XXX: Publicize code-based documentation
  // XXX: Check for parseInt/parseFloat/isNan/etc.
  // XXX: console.warn for 204/200 mismatch
  // XXX: Check `data:` wrappers
  // XXX: enforce requiredAccess:
  // XXX: validation for non-Requestable components?
  // XXX: dependencies which have not been explicitly loaded into the registry
  // XXX: schema forwarding/inclusion
  // XXX: readonly? can we handle that one better?
  // XXX: test requiredAccess
  // XXX: dquery??
  // XXX: Markdown
  // XXX: other XXXes
  // XXX: handle writing: or transactional:
  // XXX: repush
  
  // wrap this.handle() for some backwards compatibility
  handleWithRequestInfo(query, ctx, cfg /*, xdata */) {
    return this.handle(query, ctx, cfg);
  }
  
  handle(/*query, ctx, cfg*/) {
    throw new this.MissingHandler();
  }
  
  getQContext(req) {
    // XXX okay this should definitely be in server.js
    if (req.socket._qcontext) {
      return req.socket._qcontext;
    }
    
    const qctx = require('./qctx.js');
    const ctx = new qctx.QContext({parentComponent: this});
    req.socket._qcontext = ctx;
    
    ctx.properties.set('lastSessionUpdate', null);
    ctx.properties.set('pendingTicks', 0);
    
    req.socket.on('disconnect', () => {
      return this.load('UpdateUserStatistics').handle(ctx.user, ctx, true).then(() => {
        ctx.user = null;
        ctx.access = new Access();
        ctx.properties.set('lastSessionUpdate', null);
        ctx.properties.set('pendingTicks', 0);
      });
    });
    
    return ctx;
  }
  
  _handleRequest(req, res, uriMatch) {
    // get the remote address asap since it is lost with early disconnects
    const remoteAddress = req.socket.remoteAddress;
    const ctx = this.getQContext(req);
    const cfg = this.load('Config').config();
    
    let query, masterAuthorization = false;
    
    return Promise.resolve().then(() => {
      if (this.load('ReadonlyStore').readonly && this.options.writing === true) {
        throw new this.ServerReadonly();
      }
      
      if (req.method === 'GET') {
        return {};
      }
      
      if (!(req.headers['content-type'] || '').match(/^application\/(x-)?json/i)) {
        return {};
      }
      
      return new Promise((resolve, reject) => {
        const jsonStream = req.pipe(JSONStream.parse());
        
        jsonStream.on('data', resolve);
        
        jsonStream.on('error', e => {
          reject(new this.BadRequest(e));
        });
      });
    }).then(postData => {
      // key: undefined filters any possible ?key=… from the query string
      query = Object.assign({}, uriMatch, { key: undefined }, postData);
      
      const headerKey = req.headers['x-sotrade-auth'] ||
        req.headers['authorization'] ||
        req.headers['x-authorization'];
      
      if (headerKey) {
        query.key = headerKey;
      }
      
      if (query.key) {
        query.key = String(query.key);
      } else {
        query.key = null;
      }
    }).then(() => {
      deepFreeze(query);
      
      if (this.schema) {
        const validator = new ZSchema({
          noTypeless: true,
          noExtraKeywords: false,
          forceItems: true,
          forceProperties: true
        });
        
        const isValid = validator.validate(query, this.schema);
        if (!isValid) {
          throw new this.BadRequest(validator.getLastError());
        }
      }
      
      if (/^Hawk /.test(req.headers['authorization'])) {
        return new Promise((resolve, reject) => {
          Hawk.server.authenticate(req, (id, cb) => {
            return cb(null, cfg.hawk || {
              key: cfg.db.password,
              algorithm: 'sha256',
              user: 'DB-authorized user'
            });
          }, {}, (err/*, credentials, artifacts*/) => {
            if (err) {
              return reject(err);
            }
            
            masterAuthorization = true;
            resolve();
          });
        });
      }
    }).then(() => {
      if (query.key) {
        return this.load('LoadSessionUser').handle(query.key, ctx);
      } else {
        return null;
      }
    }).then(user => {
      debug('Session loading returned user', user && user.uid);
      
      const access = new Access();
      if (user !== null) {
        access.update(Access.fromJSON(user.access));
      }
      
      ctx.access.update(access);
      
      if (masterAuthorization) {
        ctx.access.grantAny();
        if (user === null && typeof query.uid !== 'undefined' && query.uid !== null) {
          user = {uid: query.uid};
        }
      }
      
      ctx.user = user;
      ctx.access[['grant', 'drop'][ctx.user && ctx.user.email_verif ? 0 : 1]]('email_verif');
      
      if (this.options.requiredLogin &&
          ctx.user === null &&
          !ctx.access.has('login-override'))
      {
        throw new this.LoginRequired();
      }
      
      if (this.options.requiredAccess && !ctx.access.has('requiredAccess')) {
        throw new this.Forbidden();
      }
      
      let useCTX = ctx;
      let handler = (query, ctx, cfg, xdata) => this.handleWithRequestInfo(query, ctx, cfg, xdata);
      
      if (this.options.transactional) {
        useCTX = ctx.clone().enterTransactionOnQuery();
        handler = useCTX.txwrap(handler);
      }
      
      return handler(query, useCTX, cfg, {
        remoteip: remoteAddress,
        headers: req.headers,
        rawRequest: req
      });
    }).catch(err => {
      if (typeof err.code === 'number') {
        return Object.assign({}, { message: err.message }, err);
      }
      
      throw err;
    }).then(answer => {
      const headers = {
        'Content-Type': 'application/json;charset=utf-8',
        'Cache-control': 'private, max-age=0, no-cache'
      };
      
      let compressor;
      
      if ((req.headers['accept-encoding'] || '').match(/lzma/)) {
        headers['Content-Encoding'] = 'lzma';
        compressor = lzma.createStream('aloneEncoder');
      } else if ((req.headers['accept-encoding'] || '').match(/gzip/)) {
        headers['Content-Encoding'] = 'gzip';
        compressor = zlib.createGzip();
      }
      
      debug('Answering request with code', answer.code);
      res.writeHead(answer.code, headers);
      if (answer.code === 204) {
        // If we say “no content”, we stick to it.
        assert.deepEqual(Object.keys(answer), ['code']);
        res.end();
      } else {
        const outJSON = JSONStream.stringify('', '', '');
        
        const ret = new Promise((resolve, reject) => {
          outJSON.on('end', resolve);
          outJSON.on('error', reject);
        });
        
        if (compressor) {
          outJSON.pipe(compressor).pipe(res);
        } else {
          outJSON.pipe(res);
        }
        
        outJSON.end(answer);
        
        return ret;
      }
    });
  }
  
  handleRequest(req, res, uriMatch, parsedURI) {
    const qsParameters = parsedURI.query;
    
    uriMatch = Object.assign({}, qsParameters, uriMatch);
    
    const booleanTable = {
      '0': false, 'false': false,
      '1': true,  'true':  true
    };
    
    // convert ?x=0 from { x: '0' } to { x: 0 } when indicated by schema
    if (this.schema && this.schema.properties) {
      for (let key of Object.keys(uriMatch)) {
        if (this.schema.properties[key]) {
          const type = this.schema.properties[key].type;
          if (type === 'integer' || type.indexOf('integer') !== -1) {
            const converted = parseInt(uriMatch[key]);
            if (!isNaN(converted)) {
              uriMatch[key] = converted;
            }
          } else if (type === 'float' || type.indexOf('float') !== -1) {
            const converted = parseFloat(uriMatch[key]);
            if (!isNaN(converted)) {
              uriMatch[key] = converted;
            }
          } else if (type === 'boolean' || type.indexOf('boolean') !== -1) {
            if (uriMatch[key] in booleanTable) {
              uriMatch[key] = booleanTable[uriMatch[key]];
            }
          }
        }
      }
    }
    
    return Promise.resolve().then(() => {
      return this._handleRequest(req, res, uriMatch);
    }).catch(e => {
      res.writeHead(500, {'Content-Type': 'application/json;charset=utf-8'});
      res.end(JSON.stringify({
        code: 500,
        error: e.toString(),
        stack: JSON.stringify(e.stack)
      }));
      
      this.load('PubSub').emit('error', e);
    });
  }
  
  getURLMatcher() {
    return this.urlMatcher;
  }
  
  handlesMethod(m) {
    return this.options.methods.indexOf(m) !== -1;
  }
}

exports.Registry = Registry;
exports.Component = Component;
exports._Component = _Component;
exports.Requestable = Requestable;
