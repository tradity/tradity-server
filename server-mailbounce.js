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

Error.stackTraceLimit = Infinity;

const debug = require('debug')('sotrade:mailbounce');
const minimist = require('minimist');
const MailParser = new require('mailparser').MailParser;
const sotradeClient = require('./sotrade-client.js');
const socket = new sotradeClient.SoTradeConnection();

let mail = null, notifying = false;
let diagnostic_code = '', messageId = '';

function notifyServer() {
  debug('Notifying server', diagnostic_code, messageId);
  
  notifying = true;
  
  return socket.post('/bounced-mail', {
    body: {
      diagnostic_code: diagnostic_code,
      messageId: messageId
    }
  }).then(() => {
    process.exit(0);
  });
}

const mailparser = new MailParser();
const options = minimist(process.argv.slice(2), {
  boolean: ['raw']
});

function handleMail(mail) {
  const attachments = mail.attachments;
  
  if (options.raw) {
    messageId = mail.headers['message-id'].replace(/^<|@.+$/g, '');
    diagnostic_code = 'Raw return to mail bounce handler script';
    
    if (!messageId) {
      return process.exit(0);
    }
    
    return notifyServer();
  }
  
  if (!attachments || attachments.length === 0) {
    return process.exit(0);
  }
  
  for (let i = 0; i < attachments.length; ++i) {
    const attachment = attachments[i];
    
    const attachmentParser = new MailParser();
    
    attachmentParser.on('end', attachmentContent => { // jshint ignore:line
      if (attachment.contentType === 'message/delivery-status') {
        const dsParser = new MailParser();
        
        dsParser.on('end', dsContent => {
          diagnostic_code = dsContent.headers['diagnostic-code'] || '[Unknown failure]';
          
          if (messageId) {
            return notifyServer();
          }
        });
        
        dsParser.end(attachmentContent.text);
      } else if (attachment.contentType === 'message/rfc822') {
        messageId = attachmentContent.headers['message-id'].replace(/^<|@.+$/g, '');
        
        if (diagnostic_code) {
          return notifyServer();
        }
      }
    });
    
    attachmentParser.end(attachment.content);
  }
  
  setTimeout(() => {
    if (!notifying) {
      process.exit(0);
    }
  }, 5000);
}

mailparser.on('end', mail_ => {
  debug('Have parsed mail');
  mail = mail_;

  handleMail(mail);
});

process.stdin.pipe(mailparser);
