#!/usr/bin/env node
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const minimist = require('minimist');
const _ = require('lodash');
const debug = require('debug')('sotrade:config');

const api = require('./api.js');
const deepupdate = require('./lib/deepupdate.js');

class Config extends api._Component {
  constructor() {
    super({
      identifier: 'Config',
      description: 'Parses and provides the server configuration.',
      notes: 'Currently, all config file loading is done upon ' +
        'module load, so no runtime re-loading is possible. ' +
        'This may change in the future.\n' +
        '\n' +
        'The server configuration is read from the <code>config/</code> directory, ' +
        'with <code>config/config.global.js</code> being the hardcoded first configuration ' +
        'file to be read. It contains most “standard” options which ' +
        'do not need to be overridden and a list of configuration file path prefixes ' +
        '(e.g. <code>/etc/sotrade/config.</code>) which are used for loading more configuration ' +
        'files, depending on the host and the working directory in which the server ' +
        'is running.'
    });
    
    this.cfg = null;
    this.otherConfigFiles = null;
  }

  /**
   * Reload all config files.
   */
  reloadConfig() {
    debug('Reloading config');
    
    this.cfg = require('./config/config.global.js');
    
    this.otherConfigFiles = this.getConfigFiles(this.cfg).filter(path => {
      try {
        fs.accessSync(path, fs.R_OK);
        return true;
      } catch (e) {
        return false;
      }
    }); // XXX

    for (let i = 0; i < this.otherConfigFiles.length; ++i) {
      let cfgFileContent = {};
      
      debug('Loading config file', this.otherConfigFiles[i]);
      try {
        cfgFileContent = require(this.otherConfigFiles[i]);
      } catch (e) { debug('Failure loading config file', this.otherConfigFiles[i], e); }
      
      this.cfg = deepupdate(this.cfg, cfgFileContent);
    }

    this.cfg.varReplace = s => {
      return s.replace(/\{\$(.+?)\}/g, (match, varname) => {
        return this.cfg[varname];
      });
    };
    
    return this;
  }

  init() {
    return Promise.resolve(this.reloadConfig());
  }
  
  /**
   * The basic structure of the server configuration.
   * 
   * @typedef module:config~SoTradeConfiguration
   * @type {object}
   * 
   * @property {object} db  Information on the database connection.
   *                        This object is also passed to the database module
   *                        as an options object.
   * @property {string} db.user  The database access user name.
   * @property {string} db.password  The database access password for the given user.
   * @property {string} wshost  The host/interface for the HTTP server to listen on.
   * @property {int[]} wsports  An array of ports for the HTTP server to listen on.
   * @property {string} userAgent  An HTTP User-Agent header to add to external HTTP
   *                               requests. This does not currently apply to the stock
   *                               loader scripts.
   * @property {object} mail  Configuration for sending mail.
   * @property {string} mail.messageIdHostname  The hostname part of the <code>Message-Id</code>
   *                                            e-mail header field.
   * @property {string} mail.transport  A transport module for use with the mail backend.
   * @property {object} mail.transportData  Options to be passed to the mail transport
   *                                        module (like SMTP host/port and authentication).
   * @property {object} mail.errorBase  A preset for the error notification mails, e.g.
   *                                    <code>From</code> and <code>To</code> headers.
   * @property {string[]} clientconfig  A list of properties of this config object which may
   *                                    be passed to the client verbatim.
   * @property {string} regurl  A template for registration URIs. This contains the variables
   *                            <code>protocol, hostname, key, uid</code>.
   * @property {string} inviteurl  A template for invite URIs. This contains the variables
   *                            <code>protocol, hostname, key</code>.
   * @property {int} lrutimeLimit  A number of seconds after a stock that has been used
   *                               (i.e. is in a depot or has been queries via the stock search
   *                               interface), during which the stock value will be updated on
   *                               a regular basis. This should be at least the time between
   *                               invocations of the regular callback.
   * @property {int} refetchLimit  A number of seconds after fetching data for a stock during
   *                               which the data is considered “fresh”, i.e. does not require
   *                               re-fetching.
   * @property {number} defaultStartingMoney  The amount of money a user starts with.
   * @property {number} leaderValueShare  The share of a user’s total assets which is
   *                                      considered their leader stock value, e.g.
   *                                      <code>leaderValueShare = 100</code> means that
   *                                      the stock for a leader whose value is 120.000 ¤
   *                                      has a stock value of 1.200 ¤.
   * @property {number} maxSingleStockShare  A value between 0.0 and 1.0 indicating the
   *                                         maximum share that a singled stock may take
   *                                         up in a user’s depot.
   * @property {number} transactionFeePerc  A value between 0.0 and 1.0 indicating how much
   *                                        transaction fees have to be paid for a single trade,
   *                                        e.g. a value of <code>0.01</code> corresponds to
   *                                        1 % of the full transaction price.
   * @property {number} transactionFeeMin  The minimum transaction fee to be paid for a trade,
   *                                       regardless of the <code>transactionFeePerc</code> setting.
   * @property {boolean} betakeyRequired  Whether a beta key is required for registering for the game.
   * @property {int} stayloggedinTime  The time span, in seconds, after which a session expires if
   *                                   the <code>.stayloggedin</code> flag is set to true in
   *                                   {@link c2s~login}.
   * @property {int} normalLoginTime  The time span, in seconds, after which a session usually exires.
   * @property {int} delayOrderHistTime  The time span, in seconds, after which delayed user order
   *                                     histories will be displayed.
   * @property {object} stockExchanges  A list of stock exchanges with specified opening and
   *                                    closing times.
   * @property {string} requireCurrency  The internal currency. Stock data records from external
   *                                     resources may be validated against using this currency.
   * @property {int} infopushMinDelta  The minimum amount of time (in milliseconds) between two
   *                                   <code>self-info</code> pushes to the client.
   * @property {object} fsdb  Configuration options pertaining to the {@link module:fsdb} module.
   * @property {regex} fsdb.reqregex  A regular expression for testing incoming HTTP request URI paths.
   *                                  In case of matching the expression, the {@link module:fsdb}
   *                                  module will handle the request, otherwise ignore it.
   * @property {string} fsdb.puburl  The URI path under which files are stores. This uses the
   *                                 <code>name</code> variable and should be matched by
   *                                 <code>.reqregex</code>.
   * @property {int} fsdb.userquota  The maximum storage an unprivileged user may take up
   *                                 (in bytes).
   * @property {object} fsdb.uniqroles  An dictionary of role -> {string[]} assignments, with
   *                                    each entry declaring fields that make the role unique.
   *                                    For example, <code>'profile.image': ['user']</code>
   *                                    states that each user may only have a single profile image.
   * @property {string[]} fsdb.allowroles  A list of file roles that an unprivileged user may
   *                                       assign to their stores files.
   * @property {string[]} fsdb.allowmime  A list of file MIME types which unprivileged users
   *                                      may upload.
   * @property {object[]} fsdb.allowProxyURIs  A list of configuration objects for proxied URIs
   *                                           that can be used like regular files, each with
   *                                           a <code>.regex</code> property for matching the
   *                                           proxy URI and a <code>.requireAccess</code> function
   *                                           which takes a {@link module:qctx~QContext} argument
   *                                           and the regex match object as the second object and
   *                                           returns a boolean indicating whether required access
   *                                           is present. <code>.requireAccess</code> may also be
   *                                           an access area identifier.
   *                                           These restrictions do not apply to users with
   *                                           sufficient privileges.
   * @property {string} protocol  The procotol under which this server is externally accessible
   *                              (e.g. <code>'https'</code>).
   * @property {string} hostname  The hostname under which this server is externally accessible.
   * @property {boolean} resetAllowed  Whether users may reset themselves to their initial finantial
   *                                   state.
   * @property {object} schoolConfigDefaults  Default option objects for schools.
   * @property {int} defaultWProvision  The default gain provision for leaders, in %.
   * @property {int} defaultLProvision  The default loss provision for leaders, in %.
   * @property {int} minWProvision  The minimum gain provision for leaders, in %.
   * @property {int} minLProvision  The minimum loss provision for leaders, in %.
   * @property {int} maxWProvision  The maximum gain provision for leaders, in %.
   * @property {int} maxLProvision  The maximum loss provision for leaders, in %.
   * @property {string} errorLogFile  A log file to write error information to.
   * @property {object} configFiles  Options for loading other config files.
   * @property {string[]} configFiles.prefixes  A list of path prefixes of other config files.
   * @property {boolean} readonly  Whether the server uses read-only mode per default.
   * @property {string} publicKeys  A list of files in which acceptable public keys are listed.
   * @property {boolean} startBackgroundWorker  Whether this server instance has a background
   *                                            worker process.
   * @property {object} ssl  A standard node.js SSL configuration object.
   */

  /**
   * Return the configuration object, as the union of all configuration files.
   * The configuration files are parsed from least specific to most specific,
   * with a list of the file prefixes being set in the main (global) configuration.
   * 
   * @return {module:config~SoTradeConfiguration} 
   * @function module:config~config
   */
  config() {
    return this.cfg;
  }

  getConfigFiles(cfg) {
    const host = os.hostname();
    const cwd = process.cwd().split(path.sep).slice(1);
    const prefixes = cfg.configFiles.prefixes || [];
    const suffix = process.env.SOTRADE_CONFIG || '';
    
    const r = [];
    
    for (let k = 0; k < prefixes.length; ++k) {
      const prefix = prefixes[k];
    
      r.push(prefix + 'global.js');
      r.push(prefix + host + '.js'); // ascending priority
      r.push(prefix + host + '-' + suffix + '.js');
      
      for (let i = 0; i < cwd.length; ++i) {
        for (let j = i+1; j <= cwd.length; ++j) {
          const pathPart = cwd.slice(i, j).join('-');
          r.push(prefix + pathPart + '.js', prefix + host + '-' + pathPart + '.js');
          r.push(prefix + pathPart + '-' + suffix + '.js', prefix + host + '-' + pathPart + '-' + suffix + '.js');
        }
      }
      
      r.push(prefix + 'local.js');
      r.push(prefix + suffix + '.js');
    }
    
    return _.uniq(r);
  }
}

class ConfigInfo extends api.Requestable {
  constructor() {
    super({
      url: '/config',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      description: 'Show the current server config.'
    });
  }
  
  handle(query, ctx, cfg) {
    return { code: 200, data: _.pick(cfg, cfg.clientconfig) };
  }
}

module.exports = Config;

Config.components = [
  Config,
  ConfigInfo
];

if (require.main === module) {
  const options = minimist(process.argv.slice(2));
  const path = options._;
  
  const config = new Config();
  config.init().then(() => {
    if (options['show-files']) {
      for (let i = 0; i < config.otherConfigFiles.length; ++i) {
        console.log(config.otherConfigFiles[i]);
      }
    } else if (path.length > 0) {
      console.log(_.get(config.config(), path));
    } else {
      console.log('Config files:', config.otherConfigFiles);
      console.log('Config:', config.config());
    }
  });
}
