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

const commonAPI = require('tradity-connection');
const https = require('https');
const debug = require('debug')('sotrade:s-client');

function NodeSoTradeConnection (opt) {
  opt = opt || {};
  
  const Config = require('./config.js');
  const cfg = opt.serverConfig || new Config().reloadConfig().config();
  
  if (!opt.url) {
    const port = cfg.wsporte || cfg.wsports[parseInt(Math.random() * cfg.wsports.length)];
    opt.url = cfg.protocol + '://' + (cfg.wshoste || cfg.wshost) + ':' + port;
  }
  
  try {
    if (!opt.messageSigner) {
      const SignedMessaging = require('./signedmsg.js').SignedMessaging;
      const smdb = new SignedMessaging();
      smdb.useConfig(cfg);
      opt.messageSigner = smdb;
    }
  } catch (e) {
    console.error(e);
  }
  
  let ownVersion = 'SOTS0';
  try {
    ownVersion = require('./buildstamp.js');
  } catch(e) {
    console.warn(e);
  }
  
  opt.clientSoftwareVersion = opt.clientSoftwareVersion || ownVersion;
  
  debug('Setting up connection', opt.url);
  return new commonAPI.SoTradeConnection(opt);
}

exports.SoTradeConnection = NodeSoTradeConnection;
