"use strict";

const commonAPI = require('tradity-connection');
const sio = require('socket.io-client');
const fs = require('fs');
const https = require('https');
const _ = require('lodash');
const debug = require('debug')('sotrade:s-client');

function NodeSoTradeConnection (opt) {
  opt = opt || {};
  
  const cfg = opt.serverConfig || require('./config.js').config();
  
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

  try {
    opt.lzma = opt.lzma || new require('lzma-native').LZMA();
  } catch (e) {
    console.error(e);
  }
  
  const socketopts = opt.socketopts || {};
  if (!socketopts.transports)
    socketopts.transports = ['websocket'];
  if (socketopts.multiplex !== true)
    socketopts.multiplex = false;
  
  if (/^(https|wss)/.test(opt.url))
    socketopts.agent = new https.Agent(cfg.ssl);
  
  const url = opt.url;
  if (url && !opt.connect) {
    opt.connect = function() {
      debug('Connecting', url, socketopts);
      return sio.connect(url, socketopts);
    };
  }
  
  if (typeof opt.logDevCheck == 'undefined')
    opt.logDevCheck = true;
  
  let ownVersion = 'SOTS0';
  try {
    ownVersion = require('./buildstamp.js');
  } catch(e) {
    console.warn(e);
  }
  
  opt.clientSoftwareVersion = opt.clientSoftwareVersion || ownVersion;
  debug('Setting up connection', opt.url);
  return new commonAPI.SoTradeConnection(opt);
};

exports.SoTradeConnection = NodeSoTradeConnection;
